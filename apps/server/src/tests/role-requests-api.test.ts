import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, makeUser } from './helpers';
import { AuditLog, RoleRequest, User } from '../models';

beforeAll(connect);
afterAll(disconnect);

const judgeBody = { role: 'judge', designation: 'professor', employeeId: 'EMP-77' };
const rolesOf = async (id: string) => (await User.findById(id))!.roles;

describe('POST /role-requests', () => {
  it('creates a pending judge request and returns it to its owner with employeeId', async () => {
    const u = await makeUser(['participant']);
    const res = await api('post', '/role-requests', u, judgeBody);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ userId: u.id, role: 'judge', status: 'pending', designation: 'professor', employeeId: 'EMP-77', decidedBy: null });
    expect(await rolesOf(u.id)).toEqual(['participant']); // requesting grants nothing
  });

  it('coordinator needs no extra fields and stores none', async () => {
    const u = await makeUser(['participant']);
    const res = await api('post', '/role-requests', u, { role: 'coordinator', designation: 'professor', employeeId: 'X' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ role: 'coordinator', status: 'pending', designation: null, employeeId: null });
  });

  it('validates input and requires auth', async () => {
    const u = await makeUser(['participant']);
    expect((await api('post', '/role-requests', u, { role: 'judge', employeeId: 'E1' })).status).toBe(400);
    expect((await api('post', '/role-requests', u, { role: 'judge', designation: 'professor' })).status).toBe(400);
    for (const role of ['organiser', 'admin', 'sponsor', 'volunteer']) expect((await api('post', '/role-requests', u, { role })).status).toBe(400);
    expect((await api('post', '/role-requests', undefined, judgeBody)).status).toBe(401);
    expect(await RoleRequest.countDocuments({ userId: u.id })).toBe(0);
  });

  it('blocks a duplicate pending request, but a different role is fine', async () => {
    const u = await makeUser(['participant']);
    expect((await api('post', '/role-requests', u, judgeBody)).status).toBe(201);
    expect((await api('post', '/role-requests', u, judgeBody)).status).toBe(409);
    expect((await api('post', '/role-requests', u, { role: 'coordinator' })).status).toBe(201);
    expect(await RoleRequest.countDocuments({ userId: u.id, role: 'judge' })).toBe(1);
  });

  it('blocks a request for a role the user already has', async () => {
    const j = await makeUser(['participant', 'judge']);
    const c = await makeUser(['coordinator']);
    expect((await api('post', '/role-requests', j, judgeBody)).status).toBe(409);
    expect((await api('post', '/role-requests', c, { role: 'coordinator' })).status).toBe(409);
    expect(await RoleRequest.countDocuments({ userId: { $in: [j.id, c.id] } })).toBe(0);
  });

  it('blocks a new request within 24h of a rejection, allows it afterwards', async () => {
    const org = await makeUser(['organiser']);
    const u = await makeUser(['participant']);
    const id = (await api('post', '/role-requests', u, judgeBody)).body.data.id;
    expect((await api('post', `/role-requests/${id}/reject`, org, {})).status).toBe(200);
    const blocked = await api('post', '/role-requests', u, judgeBody);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.retryAt).toBeTruthy();
    // a rejection of a different role does not block this one
    expect((await api('post', '/role-requests', u, { role: 'coordinator' })).status).toBe(201);
    await RoleRequest.updateOne({ _id: id }, { $set: { decidedAt: new Date(Date.now() - 25 * 3600_000) } });
    expect((await api('post', '/role-requests', u, judgeBody)).status).toBe(201);
  });
});

describe('GET /role-requests/me', () => {
  it('returns only my requests, including my employeeId', async () => {
    const a = await makeUser(['participant']);
    const b = await makeUser(['participant']);
    await api('post', '/role-requests', a, judgeBody);
    await api('post', '/role-requests', b, { ...judgeBody, employeeId: 'B-SECRET' });
    const res = await api('get', '/role-requests/me', a);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ userId: a.id, employeeId: 'EMP-77' });
    expect(JSON.stringify(res.body)).not.toContain('B-SECRET');
    expect((await api('get', '/role-requests/me')).status).toBe(401);
  });
});

describe('GET /role-requests (organiser/admin)', () => {
  it('lists with user name, email and employeeId; filters by status; admin allowed', async () => {
    const org = await makeUser(['organiser']);
    const admin = await makeUser(['admin']);
    const u = await makeUser(['participant']);
    const created = (await api('post', '/role-requests', u, judgeBody)).body.data;
    const all = await api('get', '/role-requests?status=pending', org);
    expect(all.status).toBe(200);
    const row = all.body.data.find((x: { id: string }) => x.id === created.id);
    const dbUser = (await User.findById(u.id))!;
    expect(row).toMatchObject({ role: 'judge', status: 'pending', designation: 'professor', employeeId: 'EMP-77', user: { id: u.id, name: dbUser.name, email: dbUser.email } });
    expect((await api('get', '/role-requests?status=pending', admin)).body.data.some((x: { id: string }) => x.id === created.id)).toBe(true);
    expect((await api('get', '/role-requests?status=approved', org)).body.data.some((x: { id: string }) => x.id === created.id)).toBe(false);
    expect((await api('get', '/role-requests?status=bogus', org)).status).toBe(400);
  });
});

describe('approve / reject', () => {
  it('approve adds the role, keeps existing roles, and cannot be repeated or reversed', async () => {
    const org = await makeUser(['organiser']);
    const u = await makeUser(['participant', 'volunteer']);
    const id = (await api('post', '/role-requests', u, judgeBody)).body.data.id;
    const res = await api('post', `/role-requests/${id}/approve`, org);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', decidedBy: org.id });
    expect(res.body.data.decidedAt).toBeTruthy();
    expect([...(await rolesOf(u.id))].sort()).toEqual(['judge', 'participant', 'volunteer']);
    expect((await api('post', `/role-requests/${id}/approve`, org)).status).toBe(409);
    expect((await api('post', `/role-requests/${id}/reject`, org, {})).status).toBe(409);
    expect([...(await rolesOf(u.id))].sort()).toEqual(['judge', 'participant', 'volunteer']);
    expect(await AuditLog.countDocuments({ action: 'role_request.approve', entityId: id })).toBe(1);
  });

  it('admin can approve a coordinator request', async () => {
    const admin = await makeUser(['admin']);
    const u = await makeUser(['participant']);
    const id = (await api('post', '/role-requests', u, { role: 'coordinator' })).body.data.id;
    expect((await api('post', `/role-requests/${id}/approve`, admin)).status).toBe(200);
    expect(await rolesOf(u.id)).toEqual(['participant', 'coordinator']);
  });

  it('reject stores the reason and decision, grants nothing, and cannot be repeated or approved later', async () => {
    const org = await makeUser(['organiser']);
    const u = await makeUser(['participant']);
    const id = (await api('post', '/role-requests', u, judgeBody)).body.data.id;
    const res = await api('post', `/role-requests/${id}/reject`, org, { rejectReason: 'Could not verify employee ID' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', decidedBy: org.id, rejectReason: 'Could not verify employee ID' });
    expect(await rolesOf(u.id)).toEqual(['participant']);
    expect((await api('post', `/role-requests/${id}/reject`, org, {})).status).toBe(409);
    expect((await api('post', `/role-requests/${id}/approve`, org)).status).toBe(409);
    const mine = await api('get', '/role-requests/me', u);
    expect(mine.body.data[0]).toMatchObject({ status: 'rejected', rejectReason: 'Could not verify employee ID' });
  });

  it('reject works without a body; unknown or malformed ids give 404', async () => {
    const org = await makeUser(['organiser']);
    const u = await makeUser(['participant']);
    const id = (await api('post', '/role-requests', u, { role: 'coordinator' })).body.data.id;
    const res = await api('post', `/role-requests/${id}/reject`, org);
    expect(res.status).toBe(200);
    expect(res.body.data.rejectReason).toBeNull();
    expect((await api('post', '/role-requests/64b7f0f0f0f0f0f0f0f0f0f0/approve', org)).status).toBe(404);
    expect((await api('post', '/role-requests/not-an-id/reject', org, {})).status).toBe(404);
  });
});

describe('access control', () => {
  it('normal users (and coordinators/judges) get 403 on list, approve and reject; signed-out gets 401', async () => {
    const owner = await makeUser(['participant']);
    const id = (await api('post', '/role-requests', owner, judgeBody)).body.data.id;
    for (const roles of [['participant'], ['volunteer'], ['coordinator'], ['judge']]) {
      const x = await makeUser(roles);
      expect((await api('get', '/role-requests', x)).status).toBe(403);
      expect((await api('post', `/role-requests/${id}/approve`, x)).status).toBe(403);
      expect((await api('post', `/role-requests/${id}/reject`, x, {})).status).toBe(403);
    }
    // the owner is no exception
    expect((await api('post', `/role-requests/${id}/approve`, owner)).status).toBe(403);
    expect((await api('get', '/role-requests')).status).toBe(401);
    expect((await RoleRequest.findById(id))!.status).toBe('pending');
    expect(await rolesOf(owner.id)).toEqual(['participant']);
  });
});
