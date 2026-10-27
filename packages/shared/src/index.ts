import { z } from 'zod';

/**
 * Platform roles. `admin` (Admin) is a superset of `organiser` (Organizer): anything an organiser may do, an admin may do.
 * `sponsor` (Sponsor) is an external partner account used by the sponsor portal (S7/S8). `coordinator` and `volunteer` are kept from v1.
 */
export const ROLES = ['admin', 'organiser', 'coordinator', 'participant', 'volunteer', 'judge', 'sponsor'] as const;
export type Role = (typeof ROLES)[number];
/** Roles a person may choose at public sign-up. Staff roles are granted by an organiser. */
/** Human labels for each role (UI + CSV exports). */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  organiser: 'Organizer',
  coordinator: 'Coordinator',
  participant: 'Participant',
  volunteer: 'Volunteer',
  judge: 'Judge',
  sponsor: 'Sponsor',
};
/** Roles that satisfy a requirement for `organiser` (admin is a superset). */
export const roleSatisfies = (userRoles: readonly Role[], allowed: readonly Role[]) =>
  userRoles.some((r) => allowed.includes(r)) || (userRoles.includes('admin') && allowed.includes('organiser'));
export const SELF_ASSIGNABLE_ROLES = ['participant', 'volunteer'] as const;
/** Roles a person may *request* at sign-up; an organiser approves them. Organiser, admin and sponsor can never be requested. */
export const REQUESTABLE_ROLES = ['judge', 'coordinator'] as const;
export type RequestableRole = (typeof REQUESTABLE_ROLES)[number];
export const ROLE_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type RoleRequestStatus = (typeof ROLE_REQUEST_STATUSES)[number];
export const JUDGE_DESIGNATIONS = ['lecturer', 'assistant_professor', 'associate_professor', 'professor', 'industry_expert', 'alumni', 'other'] as const;
export type JudgeDesignation = (typeof JUDGE_DESIGNATIONS)[number];
export const JUDGE_DESIGNATION_LABELS: Record<JudgeDesignation, string> = {
  lecturer: 'Lecturer',
  assistant_professor: 'Assistant Professor',
  associate_professor: 'Associate Professor',
  professor: 'Professor',
  industry_expert: 'Industry Expert',
  alumni: 'Alumni',
  other: 'Other',
};

export const EVENT_TYPES = ['seminar', 'workshop', 'competition', 'contest'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;
export const ACTIVITY_KINDS = ['seminar', 'workshop', 'competition', 'round', 'contest'] as const;
export const VERDICTS = ['AC', 'WA', 'TLE', 'RE', 'CE'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const LANGUAGES = ['c', 'cpp', 'java', 'python', 'javascript', 'typescript', 'go', 'csharp', 'rust', 'php'] as const;
export type Language = (typeof LANGUAGES)[number];
/** Human labels shown in every language picker. Keep the order: it is the order of the dropdown. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  c: 'C (GCC)',
  cpp: 'C++ (G++)',
  java: 'Java',
  python: 'Python 3',
  javascript: 'JavaScript (Node.js)',
  typescript: 'TypeScript',
  go: 'Go',
  csharp: 'C#',
  rust: 'Rust',
  php: 'PHP',
};
/** Participation type of a programming contest. TEAM = ICPC style: one shared score per team. */
export const CONTEST_MODES = ['INDIVIDUAL', 'TEAM'] as const;
export type ContestMode = (typeof CONTEST_MODES)[number];
/** A banner is either a file uploaded through POST /uploads/event-image ("/uploads/events/…"), a full http(s) URL, or '' (= none). */
export const bannerImageSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || v.startsWith('/uploads/events/') || /^https?:\/\/[^\s]+$/i.test(v), 'Use an uploaded image or a full http(s) image URL');
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80),
    email: z.string().trim().toLowerCase().email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters').max(128),
    /** Self-service role only. Judge / coordinator are never granted here: see `requestedRole`. */
    role: z.enum(SELF_ASSIGNABLE_ROLES).default('participant'),
    department: z.string().trim().max(60).optional(),
    batch: z.string().trim().max(20).optional(),
    /** Optional request for a staff role. Creates a pending RoleRequest; the account itself stays a participant. */
    requestedRole: z.enum(REQUESTABLE_ROLES).optional(),
    /** Judge requests only. */
    designation: z.enum(JUDGE_DESIGNATIONS).optional(),
    employeeId: z.string().trim().min(1, 'Employee ID is required').max(40).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.requestedRole !== 'judge') return;
    if (!v.designation) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['designation'], message: 'Designation is required for judges' });
    if (!v.employeeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['employeeId'], message: 'Employee ID is required for judges' });
  });
export type RegisterInput = z.infer<typeof registerSchema>;

/** Body of POST /role-requests (a signed-in user asks for judge or coordinator). Same judge rules as sign-up. */
export const roleRequestSchema = z
  .object({
    role: z.enum(REQUESTABLE_ROLES),
    designation: z.enum(JUDGE_DESIGNATIONS).optional(),
    employeeId: z.string().trim().min(1, 'Employee ID is required').max(40).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.role !== 'judge') return;
    if (!v.designation) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['designation'], message: 'Designation is required for judges' });
    if (!v.employeeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['employeeId'], message: 'Employee ID is required for judges' });
  });
export type RoleRequestInput = z.infer<typeof roleRequestSchema>;
/** Wait time before the same role can be requested again after a rejection. */
export const ROLE_REQUEST_COOLDOWN_HOURS = 24;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const eventSchema = z.object({
  title: z.string().trim().min(3).max(120),
  type: z.enum(EVENT_TYPES),
  description: z.string().trim().max(5000).default(''),
  eligibility: z
    .object({
      department: z.string().trim().max(60).optional(),
      batch: z.string().trim().max(20).optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .default({}),
  venueId: z.string().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  registrationDeadline: z.coerce.date(),
  capacity: z.coerce.number().int().min(1).max(100000),
  participationType: z.enum(['individual', 'team']).default('individual'),
  teamSize: z.object({ min: z.coerce.number().int().min(1), max: z.coerce.number().int().min(1) }).default({ min: 1, max: 1 }),
  requiresApproval: z.boolean().default(false),
  /** Cover image: either a file uploaded through POST /uploads/event-image ("/uploads/events/…") or an http(s) URL. Empty string clears it. */
  imageUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || v.startsWith('/uploads/events/') || /^https?:\/\/[^\s]+$/i.test(v), 'Use an uploaded image or a full http(s) image URL')
    .optional(),
});
export type EventInput = z.infer<typeof eventSchema>;

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: Record<string, unknown>;
}
export * from './exporters';
export * from './certificates';
export * from './qr';
export * from './sponsors';
export * from './leaderboard';
export * from './certTemplate';
