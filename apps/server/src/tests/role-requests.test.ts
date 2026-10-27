import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, connect, disconnect } from './helpers';
import { RoleRequest, User } from '../models';

beforeAll(connect);
afterAll(disconnect);

const register = (body: Record<string, unknown>) => request(app).post('/api/v1/auth/register').send({ name: 'Role Tester', password: 'Password123', ...body });

describe('signup role requests (step 1A)', () => {
  it('judge signup without department/batch creates a participant plus a pending request', async () => {
    const res = await register({ email: 'judge1@test.local', requestedRole: 'judge', designation: 'professor', employeeId: 'EMP-001' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.roles).toEqual(['participant']);
    const u = await User.findOne({ email: 'judge1@test.local' });
    expect(u!.roles).toEqual(['participant']);
    const reqs = await RoleRequest.find({ userId: u!.id }).lean();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ role: 'judge', status: 'pending', designation: 'professor', employeeId: 'EMP-001' });
    expect((reqs[0] as unknown as { createdAt?: Date }).createdAt).toBeInstanceOf(Date);
  });

  it('coordinator signup needs no extra fields and stores none', async () => {
    const res = await register({ email: 'coord1@test.local', requestedRole: 'coordinator', designation: 'professor', employeeId: 'X' });
    expect(res.status).toBe(201);
    const u = await User.findOne({ email: 'coord1@test.local' });
    expect(u!.roles).toEqual(['participant']);
    const r = await RoleRequest.findOne({ userId: u!.id }).lean();
    expect(r).toMatchObject({ role: 'coordinator', status: 'pending' });
    expect(r!.designation).toBeUndefined();
    expect(r!.employeeId).toBeUndefined();
  });

  it('plain signup creates no request', async () => {
    const res = await register({ email: 'plain1@test.local' });
    expect(res.status).toBe(201);
    expect(await RoleRequest.countDocuments({ userId: res.body.data.user.id })).toBe(0);
  });

  it('rejects judge signup missing designation or employeeId, and creates nothing', async () => {
    const a = await register({ email: 'bad1@test.local', requestedRole: 'judge', employeeId: 'E1' });
    const b = await register({ email: 'bad2@test.local', requestedRole: 'judge', designation: 'lecturer' });
    const c = await register({ email: 'bad3@test.local', requestedRole: 'judge', designation: 'wizard', employeeId: 'E1' });
    expect([a.status, b.status, c.status]).toEqual([400, 400, 400]);
    expect(await User.countDocuments({ email: { $in: ['bad1@test.local', 'bad2@test.local', 'bad3@test.local'] } })).toBe(0);
  });

  it.each(['organiser', 'admin', 'sponsor', 'participant', 'nonsense'])('rejects requestedRole=%s', async (requestedRole) => {
    const res = await register({ email: `inv-${requestedRole}@test.local`, requestedRole });
    expect(res.status).toBe(400);
    expect(await User.exists({ email: `inv-${requestedRole}@test.local` })).toBeNull();
  });

  it('rejects judge/coordinator as the direct signup role', async () => {
    expect((await register({ email: 'direct1@test.local', role: 'judge' })).status).toBe(400);
    expect((await register({ email: 'direct2@test.local', role: 'coordinator' })).status).toBe(400);
  });

  it('allows only one pending request per user per role (unique partial index)', async () => {
    const u = await User.findOne({ email: 'judge1@test.local' });
    await RoleRequest.syncIndexes();
    await expect(RoleRequest.create({ userId: u!.id, role: 'judge', designation: 'lecturer', employeeId: 'EMP-002' })).rejects.toThrow(/duplicate key/i);
    // a decided request does not block a new pending one
    await RoleRequest.updateOne({ userId: u!.id, role: 'judge' }, { $set: { status: 'rejected' } });
    await expect(RoleRequest.create({ userId: u!.id, role: 'judge', designation: 'lecturer', employeeId: 'EMP-002' })).resolves.toBeTruthy();
  });
});
