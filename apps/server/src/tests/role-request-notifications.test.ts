import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, connect, disconnect, makeUser } from './helpers';
import { Notification, RoleRequest, User } from '../models';

beforeAll(connect);
afterAll(disconnect);
afterEach(() => vi.restoreAllMocks());

const judgeBody = { role: 'judge', designation: 'professor', employeeId: 'EMP-1' };
const inbox = (userId: string) => Notification.find({ userId }).sort({ createdAt: 1 }).lean();
const signup = (email: string, name: string, extra: Record<string, unknown> = {}) => api('post', '/auth/register', undefined, { name, email, password: 'Password123', ...extra });
const deactivate = (id: string) => User.updateOne({ _id: id }, { $set: { active: false } });

describe('new request -> organisers and admins', () => {
  it('signup with requestedRole notifies active organisers and admins only', async () => {
    const org = await makeUser(['organiser']);
    const admin = await makeUser(['admin']);
    const coord = await makeUser(['coordinator']);
    const plain = await makeUser(['participant']);
    const gone = await makeUser(['organiser']);
    await deactivate(gone.id);

    const res = await signup('notif-judge@test.local', 'Notif Judge', { requestedRole: 'judge', designation: 'lecturer', employeeId: 'E-9' });
    expect(res.status).toBe(201);
    const rr = (await RoleRequest.findOne({ userId: res.body.data.user.id }))!;

    for (const who of [org, admin]) {
      const n = await inbox(who.id);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ type: 'role', message: 'Notif Judge requested the judge role', link: '/admin/role-requests' });
      expect(n[0].refs).toMatchObject({ roleRequestId: rr.id });
    }
    for (const who of [coord, plain, gone]) expect(await inbox(who.id)).toHaveLength(0);
    expect(await inbox(res.body.data.user.id)).toHaveLength(0); // the requester gets nothing
  });

  it('signup without requestedRole notifies nobody', async () => {
    const org = await makeUser(['organiser']);
    expect((await signup('notif-plain@test.local', 'Notif Plain')).status).toBe(201);
    expect(await inbox(org.id)).toHaveLength(0);
  });

  it('POST /role-requests notifies organisers and admins, but not the requester even if they are staff', async () => {
    const org = await makeUser(['organiser']);
    const admin = await makeUser(['admin']);
    const user = await makeUser(['participant']);
    expect((await api('post', '/role-requests', user, { role: 'coordinator' })).status).toBe(201);
    const name = (await User.findById(user.id))!.name;
    for (const who of [org, admin]) {
      const n = await Notification.find({ userId: who.id, message: `${name} requested the coordinator role` }).lean();
      expect(n).toHaveLength(1);
      expect(n[0].link).toBe('/admin/role-requests');
    }
    expect(await inbox(user.id)).toHaveLength(0);

    const staff = await makeUser(['organiser']);
    const before = await Notification.countDocuments({ userId: staff.id });
    expect((await api('post', '/role-requests', staff, judgeBody)).status).toBe(201);
    expect(await Notification.countDocuments({ userId: staff.id })).toBe(before); // not notified about their own request
  });

  it('a rejected duplicate or invalid request sends no notification', async () => {
    const org = await makeUser(['organiser']);
    const user = await makeUser(['participant']);
    await api('post', '/role-requests', user, judgeBody);
    const n = await Notification.countDocuments({ userId: org.id });
    expect((await api('post', '/role-requests', user, judgeBody)).status).toBe(409);
    expect((await api('post', '/role-requests', user, { role: 'judge' })).status).toBe(400);
    expect(await Notification.countDocuments({ userId: org.id })).toBe(n);
  });
});

describe('decision -> requester only', () => {
  it('approve notifies the requester', async () => {
    const org = await makeUser(['organiser']);
    const other = await makeUser(['organiser']);
    const user = await makeUser(['participant']);
    const id = (await api('post', '/role-requests', user, judgeBody)).body.data.id;
    const orgBefore = await Notification.countDocuments({ userId: org.id });
    expect((await api('post', `/role-requests/${id}/approve`, org)).status).toBe(200);
    const n = await inbox(user.id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'role', message: 'Your judge role request was approved', link: '/dashboard' });
    expect(await Notification.countDocuments({ userId: org.id })).toBe(orgBefore); // the deciding organiser is not notified
    expect((await api('post', `/role-requests/${id}/approve`, other)).status).toBe(409);
    expect(await inbox(user.id)).toHaveLength(1); // a failed second decision sends nothing
  });

  it('reject notifies the requester, with the reason when given', async () => {
    const org = await makeUser(['organiser']);
    const a = await makeUser(['participant']);
    const b = await makeUser(['participant']);
    const idA = (await api('post', '/role-requests', a, judgeBody)).body.data.id;
    const idB = (await api('post', '/role-requests', b, { role: 'coordinator' })).body.data.id;
    await api('post', `/role-requests/${idA}/reject`, org, { rejectReason: 'Could not verify ID' });
    await api('post', `/role-requests/${idB}/reject`, org, {});
    const na = await inbox(a.id);
    const nb = await inbox(b.id);
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ message: 'Your judge role request was rejected. Reason: Could not verify ID', link: '/dashboard' });
    expect(nb).toHaveLength(1);
    expect(nb[0]).toMatchObject({ message: 'Your coordinator role request was rejected', link: '/dashboard' });
  });
});

describe('PATCH /users/:id/roles', () => {
  it('notifies the affected user about added and removed roles', async () => {
    const org = await makeUser(['organiser']);
    const bystander = await makeUser(['participant']);
    const u = await makeUser(['participant', 'volunteer']);
    expect((await api('patch', `/users/${u.id}/roles`, org, { roles: ['participant', 'judge'] })).status).toBe(200);
    const n = await inbox(u.id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'role', message: 'Your roles were updated: added Judge; removed Volunteer.', link: '/dashboard' });
    expect(await inbox(bystander.id)).toHaveLength(0);

    expect((await api('patch', `/users/${u.id}/roles`, org, { roles: ['participant', 'judge', 'coordinator'] })).status).toBe(200);
    expect((await inbox(u.id))[1].message).toBe('Your roles were updated: added Coordinator.');
  });

  it('does not notify when nothing changed (including a reordered list)', async () => {
    const org = await makeUser(['organiser']);
    const u = await makeUser(['participant', 'volunteer']);
    expect((await api('patch', `/users/${u.id}/roles`, org, { roles: ['participant', 'volunteer'] })).status).toBe(200);
    expect((await api('patch', `/users/${u.id}/roles`, org, { roles: ['volunteer', 'participant'] })).status).toBe(200);
    expect(await inbox(u.id)).toHaveLength(0);
  });

  it('a forbidden or invalid change sends nothing', async () => {
    const p = await makeUser(['participant']);
    const u = await makeUser(['participant']);
    expect((await api('patch', `/users/${u.id}/roles`, p, { roles: ['organiser'] })).status).toBe(403);
    expect(await inbox(u.id)).toHaveLength(0);
  });
});

describe('notification failures never break the request', () => {
  const boom = () => vi.spyOn(Notification, 'create').mockRejectedValue(new Error('notifications are down'));

  it('signup and POST /role-requests still succeed and create the request', async () => {
    await makeUser(['organiser']);
    boom();
    const s = await signup('notif-down@test.local', 'Notif Down', { requestedRole: 'judge', designation: 'alumni', employeeId: 'E-1' });
    expect(s.status).toBe(201);
    expect(await RoleRequest.countDocuments({ userId: s.body.data.user.id, status: 'pending' })).toBe(1);
    const u = await makeUser(['participant']);
    expect((await api('post', '/role-requests', u, { role: 'coordinator' })).status).toBe(201);
  });

  it('approve and reject still change state, and role changes still apply', async () => {
    const org = await makeUser(['organiser']);
    const a = await makeUser(['participant']);
    const b = await makeUser(['participant']);
    const c = await makeUser(['participant']);
    const idA = (await api('post', '/role-requests', a, judgeBody)).body.data.id;
    const idB = (await api('post', '/role-requests', b, { role: 'coordinator' })).body.data.id;
    boom();
    expect((await api('post', `/role-requests/${idA}/approve`, org)).status).toBe(200);
    expect((await api('post', `/role-requests/${idB}/reject`, org, { rejectReason: 'no' })).status).toBe(200);
    expect((await api('patch', `/users/${c.id}/roles`, org, { roles: ['participant', 'judge'] })).status).toBe(200);
    expect((await User.findById(a.id))!.roles).toEqual(['participant', 'judge']);
    expect((await RoleRequest.findById(idB))!.status).toBe('rejected');
    expect((await User.findById(c.id))!.roles).toEqual(['participant', 'judge']);
  });

  it('one failing recipient does not stop the others', async () => {
    const o1 = await makeUser(['organiser']);
    const o2 = await makeUser(['organiser']);
    const u = await makeUser(['participant']);
    const real = Notification.create.bind(Notification) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(Notification, 'create').mockImplementation(((doc: { userId: unknown }) => (String(doc.userId) === o1.id ? Promise.reject(new Error('x')) : real(doc))) as never);
    expect((await api('post', '/role-requests', u, { role: 'coordinator' })).status).toBe(201);
    vi.restoreAllMocks();
    expect(await inbox(o1.id)).toHaveLength(0);
    expect(await inbox(o2.id)).toHaveLength(1);
  });
});
