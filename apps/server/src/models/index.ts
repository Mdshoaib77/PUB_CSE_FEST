import mongoose, { Schema, model, Types } from 'mongoose';
import { ACTIVITY_KINDS, CERTIFICATE_STATUSES, CONTRIBUTION_TYPES, DELIVERABLE_STATUSES, DELIVERABLE_TYPES, SPONSOR_STATUSES, SPONSOR_TIERS, tierRank, CERTIFICATE_TYPES, CERTIFICATE_KINDS, CONTEST_MODES, DIFFICULTIES, EVENT_STATUSES, EVENT_TYPES, JUDGE_DESIGNATIONS, LANGUAGES, REQUESTABLE_ROLES, ROLE_REQUEST_STATUSES, ROLES } from '@festhub/shared';

const oidRef = (ref: string, extra: object = {}) => ({ type: Schema.Types.ObjectId, ref, ...extra });
const opts = { timestamps: true };

// ---------- Users / auth ----------
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    roles: { type: [String], enum: ROLES, default: ['participant'] },
    department: String,
    batch: String,
    active: { type: Boolean, default: true },
  },
  opts,
);
export const User = model('User', userSchema);

const refreshSchema = new Schema(
  {
    userId: oidRef('User', { index: true }),
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
  },
  opts,
);
export const RefreshToken = model('RefreshToken', refreshSchema);

/** A signed-up user asking an organiser for the judge or coordinator role. Approval itself is handled in a later step. */
const roleRequestSchema = new Schema(
  {
    userId: oidRef('User', { required: true, index: true }),
    role: { type: String, enum: REQUESTABLE_ROLES, required: true },
    status: { type: String, enum: ROLE_REQUEST_STATUSES, default: 'pending' },
    // judge only
    designation: { type: String, enum: JUDGE_DESIGNATIONS, required: function (this: { role?: string }) { return this.role === 'judge'; } },
    employeeId: { type: String, trim: true, required: function (this: { role?: string }) { return this.role === 'judge'; } },
    decidedBy: oidRef('User'),
    decidedAt: Date,
    rejectReason: String,
  },
  opts, // timestamps -> createdAt
);
// at most one pending request per user per role
roleRequestSchema.index({ userId: 1, role: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
export const RoleRequest = model('RoleRequest', roleRequestSchema);

// ---------- Venues / events ----------
export const Venue = model(
  'Venue',
  new Schema(
    {
      name: { type: String, required: true, unique: true, trim: true },
      building: { type: String, trim: true },
      capacity: Number,
    },
    opts,
  ),
);

const eventSchema = new Schema(
  {
    title: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    description: { type: String, default: '' },
    eligibility: { department: String, batch: String, notes: String },
    venueId: oidRef('Venue'),
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    registrationDeadline: { type: Date, required: true },
    capacity: { type: Number, required: true, min: 1 },
    participationType: { type: String, enum: ['individual', 'team'], default: 'individual' },
    teamSize: { min: { type: Number, default: 1 }, max: { type: Number, default: 1 } },
    requiresApproval: { type: Boolean, default: false },
    imageUrl: { type: String, default: undefined },
    status: { type: String, enum: EVENT_STATUSES, default: 'draft' },
    createdBy: oidRef('User'),
  },
  opts,
);
eventSchema.index({ status: 1, startAt: 1 });
export const Event = model('Event', eventSchema);

const activitySchema = new Schema(
  {
    eventId: oidRef('Event', { required: true, index: true }),
    title: { type: String, required: true },
    kind: { type: String, enum: ACTIVITY_KINDS, required: true },
    parentId: oidRef('Activity'), // rounds point at their competition
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    venueId: oidRef('Venue'),
    submissionDeadline: Date, // for competition entries
    status: { type: String, enum: ['scheduled', 'cancelled'], default: 'scheduled' },
  },
  opts,
);
activitySchema.index({ venueId: 1, start: 1, end: 1 });
export const Activity = model('Activity', activitySchema);

// ---------- Registration / teams ----------
const registrationSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true }),
    subjectKey: { type: String, required: true }, // 'u:<id>' | 't:<id>' ; replaced on cancel to free the unique key
    userId: oidRef('User'),
    teamId: oidRef('Team'),
    status: { type: String, enum: ['pending_approval', 'confirmed', 'waitlisted', 'rejected', 'cancelled'], required: true },
    holdsSeat: { type: Boolean, default: false },
    waitlistPosition: Number,
    decidedBy: oidRef('User'),
  },
  opts,
);
registrationSchema.index({ eventId: 1, subjectKey: 1 }, { unique: true });
registrationSchema.index({ eventId: 1, status: 1, waitlistPosition: 1 });
export const Registration = model('Registration', registrationSchema);

// A seat is a unique (eventId, seatNo) row: the unique index (not read-modify-write) is what makes overbooking impossible.
const seatSchema = new Schema(
  { eventId: oidRef('Event', { required: true }), seatNo: { type: Number, required: true }, registrationId: oidRef('Registration', { required: true }) },
  opts,
);
seatSchema.index({ eventId: 1, seatNo: 1 }, { unique: true });
seatSchema.index({ registrationId: 1 });
export const Seat = model('Seat', seatSchema);

const teamSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true }),
    name: { type: String, required: true, trim: true },
    leaderId: oidRef('User', { required: true }),
    memberCount: { type: Number, default: 1 }, // atomic guard for max team size
  },
  opts,
);
teamSchema.index({ eventId: 1, name: 1 }, { unique: true });
export const Team = model('Team', teamSchema);

const teamMemberSchema = new Schema(
  {
    teamId: oidRef('Team', { required: true }),
    eventId: oidRef('Event', { required: true }),
    userId: oidRef('User', { required: true }),
  },
  opts,
);
teamMemberSchema.index({ eventId: 1, userId: 1 }, { unique: true }); // one team per event per person
teamMemberSchema.index({ teamId: 1, userId: 1 }, { unique: true });
export const TeamMember = model('TeamMember', teamMemberSchema);

const invitationSchema = new Schema(
  {
    teamId: oidRef('Team', { required: true }),
    eventId: oidRef('Event', { required: true }),
    /** Set for account holders; absent while the invite is e-mail-only (attached when that person registers or logs in). */
    inviteeId: oidRef('User'),
    inviteeEmail: { type: String, lowercase: true, trim: true, maxlength: 254 },
    invitedBy: oidRef('User', { required: true }),
    status: { type: String, enum: ['pending', 'accepted', 'rejected', 'cancelled'], default: 'pending' },
    /** Invitations expire 14 days after they are (re)sent. */
    expiresAt: Date,
    lastSentAt: Date,
    /** `<teamId>:u:<userId>` or `<teamId>:e:<email>`: one row per (team, invitee), safe for e-mail-only invites. */
    slotKey: { type: String, unique: true, sparse: true },
  },
  opts,
);
invitationSchema.index({ teamId: 1, status: 1 });
invitationSchema.index({ inviteeId: 1, status: 1 });
invitationSchema.index({ inviteeEmail: 1, status: 1 });
export const Invitation = model('Invitation', invitationSchema);

const notificationSchema = new Schema(
  {
    userId: oidRef('User', { required: true, index: true }),
    type: { type: String, default: 'general' },
    /** Short headline (S3). Older rows get one from the migration. */
    title: { type: String, maxlength: 120 },
    message: { type: String, required: true },
    /** In-app path to open when clicked, e.g. "/events/abc" (always starts with a single "/"). */
    link: { type: String, maxlength: 300 },
    refs: Schema.Types.Mixed,
    readAt: Date,
  },
  opts,
);
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 }); // unread badge count + newest-first list
export const Notification = model('Notification', notificationSchema);

export const Announcement = model(
  'Announcement',
  new Schema(
    {
      eventId: oidRef('Event', { required: true, index: true }),
      authorId: oidRef('User'),
      title: { type: String, required: true },
      body: { type: String, required: true },
      pinned: { type: Boolean, default: false },
    },
    opts,
  ),
);

// ---------- Volunteers / ops ----------
const availabilitySchema = new Schema(
  {
    userId: oidRef('User', { required: true }),
    eventId: oidRef('Event', { required: true }),
    slots: [{ start: Date, end: Date }],
  },
  opts,
);
availabilitySchema.index({ userId: 1, eventId: 1 }, { unique: true });
export const Availability = model('Availability', availabilitySchema);

const shiftSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true, index: true }),
    activityId: oidRef('Activity'),
    title: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    requiredCount: { type: Number, default: 1, min: 1 },
  },
  opts,
);
export const Shift = model('Shift', shiftSchema);

const shiftAssignmentSchema = new Schema(
  {
    shiftId: oidRef('Shift', { required: true }),
    eventId: oidRef('Event', { required: true }),
    volunteerId: oidRef('User', { required: true, index: true }),
    status: { type: String, enum: ['assigned', 'replaced', 'cancelled'], default: 'assigned' },
    attendance: { type: String, enum: ['unmarked', 'present', 'absent'], default: 'unmarked' },
    attendanceAt: Date,
    attendanceBy: oidRef('User'),
  },
  opts,
);
shiftAssignmentSchema.index({ shiftId: 1, volunteerId: 1 }, { unique: true });
export const ShiftAssignment = model('ShiftAssignment', shiftAssignmentSchema);

export const Task = model(
  'Task',
  new Schema(
    {
      eventId: oidRef('Event', { required: true, index: true }),
      shiftId: oidRef('Shift'),
      title: { type: String, required: true },
      assigneeId: oidRef('User', { index: true }),
      status: { type: String, enum: ['todo', 'done'], default: 'todo' },
      completedAt: Date,
    },
    opts,
  ),
);

export const ReplacementRequest = model(
  'ReplacementRequest',
  new Schema(
    {
      assignmentId: oidRef('ShiftAssignment', { required: true }),
      eventId: oidRef('Event', { required: true, index: true }),
      requestedBy: oidRef('User', { required: true }),
      proposedVolunteerId: oidRef('User'),
      reason: String,
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      decidedBy: oidRef('User'),
      decisionNote: String,
    },
    opts,
  ),
);

const checkInTokenSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true }),
    subjectKey: { type: String, required: true }, // 'p:<registrationId>' | 'v:<userId>'
    subjectType: { type: String, enum: ['participant', 'volunteer'], required: true },
    userId: oidRef('User', { required: true }),
    jti: { type: String, required: true, unique: true },
    /** Short human-typable code (8 chars, no 0/O/1/I) for volunteers whose camera is missing or blocked. Stored without the dash. */
    manualCode: { type: String, index: { unique: true, sparse: true } },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  },
  opts,
);
checkInTokenSchema.index({ eventId: 1, subjectKey: 1 }, { unique: true });
export const CheckInToken = model('CheckInToken', checkInTokenSchema);

const checkInSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true }),
    subjectKey: { type: String, required: true },
    subjectType: String,
    userId: oidRef('User'),
    operatorId: oidRef('User', { required: true }),
    at: { type: Date, default: Date.now },
  },
  opts,
);
checkInSchema.index({ eventId: 1, subjectKey: 1 }, { unique: true }); // duplicate check-in impossible at DB level
export const CheckIn = model('CheckIn', checkInSchema);

export const Issue = model(
  'Issue',
  new Schema(
    {
      eventId: oidRef('Event', { required: true, index: true }),
      title: { type: String, required: true },
      description: String,
      priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      status: { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
      ownerId: oidRef('User'),
      reportedBy: oidRef('User'),
      comments: [{ authorId: oidRef('User'), text: String, at: { type: Date, default: Date.now } }],
      resolution: String,
      resolvedAt: Date,
    },
    opts,
  ),
);

// ---------- Competition judging ----------
export const Rubric = model(
  'Rubric',
  new Schema(
    {
      activityId: oidRef('Activity', { required: true, unique: true }),
      criteria: [{ name: { type: String, required: true }, maxScore: { type: Number, required: true, min: 1 }, weight: { type: Number, default: 1, min: 0 } }],
    },
    opts,
  ),
);

const entrySchema = new Schema(
  {
    activityId: oidRef('Activity', { required: true }),
    eventId: oidRef('Event', { required: true }),
    ownerKey: { type: String, required: true }, // 'u:<id>' | 't:<id>'
    ownerUserId: oidRef('User'),
    teamId: oidRef('Team'),
    title: { type: String, required: true },
    currentVersion: { type: Number, default: 1 },
  },
  opts,
);
entrySchema.index({ activityId: 1, ownerKey: 1 }, { unique: true });
export const Entry = model('Entry', entrySchema);

const entryVersionSchema = new Schema(
  {
    entryId: oidRef('Entry', { required: true }),
    version: { type: Number, required: true },
    content: { type: String, default: '' },
    link: String,
    notes: String,
    submittedBy: oidRef('User'),
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
entryVersionSchema.index({ entryId: 1, version: 1 }, { unique: true }); // append-only; no update route exists
export const EntryVersion = model('EntryVersion', entryVersionSchema);

const judgeAssignmentSchema = new Schema(
  {
    entryId: oidRef('Entry', { required: true }),
    activityId: oidRef('Activity', { required: true, index: true }),
    judgeId: oidRef('User', { required: true, index: true }),
  },
  opts,
);
judgeAssignmentSchema.index({ entryId: 1, judgeId: 1 }, { unique: true });
export const JudgeAssignment = model('JudgeAssignment', judgeAssignmentSchema);

const scoreSchema = new Schema(
  {
    entryId: oidRef('Entry', { required: true }),
    activityId: oidRef('Activity', { required: true, index: true }),
    judgeId: oidRef('User', { required: true }),
    versionScored: Number,
    criterionScores: [{ name: String, score: Number }],
    feedback: String,
    percent: Number,
  },
  opts,
);
scoreSchema.index({ entryId: 1, judgeId: 1 }, { unique: true });
export const Score = model('Score', scoreSchema);

export const Result = model(
  'Result',
  new Schema(
    {
      activityId: oidRef('Activity', { required: true, unique: true }),
      rankings: [{ entryId: oidRef('Entry'), title: String, ownerKey: String, ownerName: String, percent: Number, judgeCount: Number, rank: Number }],
      status: { type: String, enum: ['draft', 'official'], default: 'draft' },
      computedAt: Date,
      approvedBy: oidRef('User'),
      approvedAt: Date,
    },
    opts,
  ),
);

// ---------- Certificates (S5) ----------
const certificateSchema = new Schema(
  {
    certId: { type: String, required: true, unique: true }, // FH-XXXX-XXXX-XXXX-CC (see shared/certificates.ts)
    eventId: oidRef('Event'), // v4: optional (a contest that is not linked to an event); always set for event certificates
    /** Individual: the recipient. TEAM certificate: the team leader (keeps old queries/permissions working); all members are in `recipients`. */
    userId: oidRef('User', { required: true }),
    /** v4. Old documents have no value; the migration sets 'individual'. */
    kind: { type: String, enum: CERTIFICATE_KINDS, default: 'individual' },
    teamId: Schema.Types.ObjectId, // Team (event) or ContestTeam (contest), depending on contestId; no ref: it is a snapshot reference only
    teamName: String, // snapshot
    contestId: oidRef('Contest'),
    /** v4 snapshot of everyone on the certificate, LEADER FIRST (team) or just the recipient (individual). Never recomputed. */
    recipients: { type: [new Schema({ userId: oidRef('User', { required: true }), name: { type: String, required: true } }, { _id: false })], default: [] },
    activityId: oidRef('Activity'), // set for winner / runner-up (the competition the position belongs to)
    type: { type: String, enum: CERTIFICATE_TYPES, required: true },
    status: { type: String, enum: CERTIFICATE_STATUSES, default: 'valid' },
    position: Number, // 1 = winner, 2 = runner-up
    positionLabel: String, // e.g. "1st Place - Poster Design Competition"
    // Snapshots: a certificate must keep reading the same even if the user/event is renamed or deleted later.
    recipientName: { type: String, required: true },
    eventTitle: { type: String, required: true },
    eventDate: { type: Date, required: true },
    signatureText: { type: String, default: '' },
    /** Uniqueness of "one valid certificate per person, event, type (and activity)". Replaced by `x:<certId>` on revoke, which frees the slot (same trick as Registration.subjectKey). */
    slotKey: { type: String, required: true, unique: true },
    issuedBy: oidRef('User'),
    issuedAt: { type: Date, default: Date.now },
    revokedAt: Date,
    revokedBy: oidRef('User'),
    revokeReason: String,
    replacesId: String, // certId of the certificate this one replaced (reissue)
    replacedById: String, // certId of the certificate that replaced this one
  },
  opts,
);
certificateSchema.index({ eventId: 1, type: 1 });
certificateSchema.index({ userId: 1, issuedAt: -1 });
certificateSchema.index({ 'recipients.userId': 1, issuedAt: -1 });
certificateSchema.index({ contestId: 1, type: 1 });
export const Certificate = model('Certificate', certificateSchema);

// ---------- Certificate template (S6): one per event; branding used when a PDF is rendered ----------
const certificateTemplateSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true, unique: true }),
    logoUrl: String, // /uploads/certs/<hex>.(jpg|png)
    signatureImageUrl: String,
    signatureName: { type: String, default: '' },
    signatureTitle: { type: String, default: '' },
    primaryColor: { type: String, default: '#4f46e5' },
    accentColor: { type: String, default: '#d94c33' },
    // v6 (all optional: documents written before v6 simply lack them and read as defaults)
    theme: { type: String, enum: ['royal', 'emerald', 'sunset', 'violet', 'custom'], default: 'custom' },
    logo2Url: String,
    /** Up to 3 signatories. `default: undefined` keeps "never migrated" distinguishable from "empty" (legacy signature* fields mirror slot 1). */
    signatories: {
      type: [new Schema({ name: { type: String, default: '', maxlength: 40 }, title: { type: String, default: '', maxlength: 80 }, imageUrl: String }, { _id: false })],
      default: undefined,
    },
    sealEnabled: { type: Boolean, default: true },
    borderStyle: { type: String, enum: ['classic', 'modern', 'minimal'], default: 'classic' },
    fontStyle: { type: String, enum: ['serif', 'sans'], default: 'serif' },
    headlines: { type: Map, of: { type: String, maxlength: 50 }, default: undefined },
    bodyText: { type: String, default: '', maxlength: 280 },
    customFields: {
      type: [new Schema({ label: { type: String, default: '', maxlength: 24 }, value: { type: String, default: '', maxlength: 48 } }, { _id: false })],
      default: undefined,
    },
    updatedBy: oidRef('User'),
  },
  opts,
);
export const CertificateTemplate = model('CertificateTemplate', certificateTemplateSchema);

// ---------- Sponsors (S7) ----------
const sponsorSchema = new Schema(
  {
    company: { type: String, required: true, trim: true, maxlength: 120 },
    contactName: { type: String, trim: true, maxlength: 120, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 40 },
    tier: { type: String, enum: SPONSOR_TIERS, default: 'partner' },
    /** Denormalised from `tier` (0 = Title ... 4 = Partner) so lists can be sorted + paginated by tier in the database. Kept in sync by the pre-validate hook. */
    tierRank: { type: Number, default: 4, index: true },
    contributionType: { type: String, enum: CONTRIBUTION_TYPES, default: 'cash' },
    amount: { type: Number, default: 0, min: 0 }, // agreed contribution value (for in-kind/service: estimated value)
    status: { type: String, enum: SPONSOR_STATUSES, default: 'prospect' },
    nextFollowUpAt: Date,
    /** The follow-up date a reminder was last sent for (dedupe: one reminder per scheduled date). */
    reminderFor: Date,
    notes: { type: String, maxlength: 2000, default: '' },
    ownerId: oidRef('User'), // organiser responsible for the relationship (gets the reminders); defaults to the creator
    userId: oidRef('User'), // optional portal login of the sponsor (used from S8)
    createdBy: oidRef('User'),
  },
  opts,
);
sponsorSchema.pre('validate', function (next) {
  this.tierRank = tierRank(this.tier);
  next();
});
sponsorSchema.index({ status: 1, nextFollowUpAt: 1 });
sponsorSchema.index({ tierRank: 1, company: 1 });
export const Sponsor = model('Sponsor', sponsorSchema);

const sponsorEventSchema = new Schema({ sponsorId: oidRef('Sponsor', { required: true }), eventId: oidRef('Event', { required: true }), linkedBy: oidRef('User') }, opts);
sponsorEventSchema.index({ sponsorId: 1, eventId: 1 }, { unique: true });
sponsorEventSchema.index({ eventId: 1 });
export const SponsorEvent = model('SponsorEvent', sponsorEventSchema);

const deliverableSchema = new Schema(
  {
    sponsorId: oidRef('Sponsor', { required: true, index: true }),
    eventId: oidRef('Event'),
    type: { type: String, enum: DELIVERABLE_TYPES, required: true },
    title: { type: String, trim: true, maxlength: 160, default: '' },
    status: { type: String, enum: DELIVERABLE_STATUSES, default: 'pending' },
    dueAt: Date,
    doneAt: Date,
  },
  opts,
);
export const Deliverable = model('Deliverable', deliverableSchema);

const sponsorPaymentSchema = new Schema(
  {
    sponsorId: oidRef('Sponsor', { required: true, index: true }),
    eventId: oidRef('Event'),
    pledged: { type: Number, default: 0, min: 0 },
    received: { type: Number, default: 0, min: 0 },
    dueDate: Date,
    receivedAt: Date,
    note: { type: String, maxlength: 300, default: '' },
    receiptFile: String, // file name inside the PRIVATE receipts dir (never served statically)
    receiptName: String, // original file name, for the download header only
    receiptMime: String,
    recordedBy: oidRef('User'),
  },
  opts,
);
sponsorPaymentSchema.index({ dueDate: 1 });
export const SponsorPayment = model('SponsorPayment', sponsorPaymentSchema);

const auditLogSchema = new Schema(
  {
    actorId: oidRef('User'),
    /** Snapshot of the actor's name at the time of the action (the user may later be renamed or deleted). */
    actorName: String,
    action: { type: String, required: true, maxlength: 80 },
    entityType: String,
    entityId: String,
    meta: Schema.Types.Mixed,
    ip: String,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
export const AuditLog = model('AuditLog', auditLogSchema);

/** Bookkeeping for run-once migrations (services/migrations.ts). */
export const Migration = model(
  'Migration',
  new Schema({ name: { type: String, required: true, unique: true }, appliedAt: { type: Date, default: Date.now } }, { timestamps: false }),
);

// ---------- Programming contest ----------
const problemSchema = new Schema(
  {
    title: { type: String, required: true },
    statement: { type: String, required: true },
    constraints: String,
    inputDesc: String,
    outputDesc: String,
    samples: [{ input: String, output: String, explanation: String }],
    tags: { type: [String], index: true },
    difficulty: { type: String, enum: DIFFICULTIES, default: 'easy' },
    timeLimitMs: { type: Number, default: 2000, min: 100, max: 15000 },
    memoryLimitKb: { type: Number, default: 262144, min: 16384, max: 1048576 },
    languages: { type: [String], enum: LANGUAGES, default: [...LANGUAGES] },
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    authorId: oidRef('User'),
  },
  opts,
);
export const Problem = model('Problem', problemSchema);

// Hidden test data lives ONLY here and is never selected by default.
const testCaseSchema = new Schema(
  {
    problemId: oidRef('Problem', { required: true }),
    order: { type: Number, required: true },
    input: { type: String, select: false, default: '' },
    expectedOutput: { type: String, select: false, default: '' },
  },
  opts,
);
testCaseSchema.index({ problemId: 1, order: 1 }, { unique: true });
export const TestCase = model('TestCase', testCaseSchema);

const contestSchema = new Schema(
  {
    eventId: oidRef('Event'),
    title: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    /** Last moment people can register / create or join a team. Empty = open until the contest ends. */
    registrationDeadline: Date,
    venueId: oidRef('Venue'),
    freezeAt: Date, // scoreboard hidden from this moment
    revealAt: Date, // defaults to endAt when not set
    revealed: { type: Boolean, default: false }, // organiser manual reveal
    problems: [{ problemId: oidRef('Problem'), label: String }],
    penaltyMinutes: { type: Number, default: 20 },
    cooldownSec: { type: Number, default: 10 },
    description: { type: String, default: '' },
    /** Banner shown on the contest list, contest page and organiser dashboard. Uploaded ("/uploads/events/…") or an http(s) URL. */
    bannerImage: { type: String, default: undefined },
    /** INDIVIDUAL: one score per person. TEAM: ICPC style, one shared score per team. Locked once anyone has registered. */
    mode: { type: String, enum: CONTEST_MODES, default: 'INDIVIDUAL' },
    teamSize: { min: { type: Number, default: 1 }, max: { type: Number, default: 3 } },
    createdBy: oidRef('User'),
  },
  opts,
);
export const Contest = model('Contest', contestSchema);

// In TEAM mode every member still gets a ContestRegistration row (so all access checks stay per-user) that points at the team.
const contestRegSchema = new Schema(
  { contestId: oidRef('Contest', { required: true }), userId: oidRef('User', { required: true }), teamId: oidRef('ContestTeam') },
  opts,
);
contestRegSchema.index({ contestId: 1, userId: 1 }, { unique: true });
contestRegSchema.index({ contestId: 1, teamId: 1 });
export const ContestRegistration = model('ContestRegistration', contestRegSchema);

const contestTeamSchema = new Schema(
  {
    contestId: oidRef('Contest', { required: true, index: true }),
    name: { type: String, required: true, trim: true },
    leaderId: oidRef('User', { required: true }),
    /** Teammates join with this code (the leader shares it). */
    joinCode: { type: String, required: true, unique: true },
    memberCount: { type: Number, default: 1 }, // atomic guard for the maximum team size
    /** Set when the leader registers the team (needs the minimum number of members). A team without it is only a draft: it cannot see problems, submit or appear on the scoreboard. */
    registeredAt: Date,
  },
  opts,
);
contestTeamSchema.index({ contestId: 1, name: 1 }, { unique: true });
export const ContestTeam = model('ContestTeam', contestTeamSchema);

/** E-mail / in-app invitation to join a contest team (the join code keeps working alongside). Expires 14 days after (re)sending. */
const contestTeamInviteSchema = new Schema(
  {
    contestId: oidRef('Contest', { required: true, index: true }),
    teamId: oidRef('ContestTeam', { required: true }),
    /** Set for account holders; absent while the invite is e-mail-only (attached when that person registers or logs in). */
    inviteeId: oidRef('User'),
    inviteeEmail: { type: String, lowercase: true, trim: true, maxlength: 254 },
    invitedBy: oidRef('User', { required: true }),
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled', 'expired'], default: 'pending' },
    expiresAt: Date,
    lastSentAt: Date,
    /** `<teamId>:u:<userId>` or `<teamId>:e:<email>`: one row per (team, invitee). */
    slotKey: { type: String, required: true, unique: true },
  },
  opts,
);
contestTeamInviteSchema.index({ teamId: 1, status: 1 });
contestTeamInviteSchema.index({ inviteeId: 1, contestId: 1, status: 1 });
contestTeamInviteSchema.index({ inviteeEmail: 1, status: 1 });
export const ContestTeamInvitation = model('ContestTeamInvitation', contestTeamInviteSchema);

const submissionSchema = new Schema(
  {
    userId: oidRef('User', { required: true, index: true }),
    problemId: oidRef('Problem', { required: true }),
    contestId: oidRef('Contest'),
    mode: { type: String, enum: ['contest', 'practice'], required: true },
    language: { type: String, enum: LANGUAGES, required: true },
    code: { type: String, required: true, select: false },
    status: { type: String, enum: ['queued', 'running', 'AC', 'WA', 'TLE', 'RE', 'CE', 'JE'], default: 'queued' },
    failedTest: Number, // index only: never the data
    timeMs: Number,
    memoryKb: Number,
    attempts: { type: Number, default: 0 },
    judgeJobKey: { type: String, required: true, unique: true },
    submittedAt: { type: Date, default: Date.now },
    judgedAt: Date,
  },
  { timestamps: false },
);
submissionSchema.index({ contestId: 1, submittedAt: 1 });
submissionSchema.index({ userId: 1, problemId: 1 });
export const Submission = model('Submission', submissionSchema);

export const Editorial = model(
  'Editorial',
  new Schema(
    {
      problemId: oidRef('Problem', { required: true, unique: true }),
      content: { type: String, required: true },
      releaseAt: Date,
      authorId: oidRef('User'),
    },
    opts,
  ),
);


// ---------- Plagiarism (S11) ----------
const PLAG_LANGS = ['python', 'c', 'cpp', 'java', 'javascript'] as const;
/** A piece of code handed in for similarity checking (pasted or uploaded). `scopeKey` = `p:<problemId>` when a problem is given, else `e:<eventId>`; only same-scope, same-language code is compared. */
const codeSubmissionSchema = new Schema(
  {
    userId: oidRef('User', { required: true, index: true }),
    eventId: oidRef('Event'),
    problemId: oidRef('Problem'),
    scopeKey: { type: String, required: true, index: true },
    language: { type: String, enum: PLAG_LANGS, required: true },
    code: { type: String, required: true, select: false },
    source: { type: String, enum: ['paste', 'upload'], default: 'paste' },
    fileName: String,
    sizeBytes: { type: Number, default: 0 },
    codeHash: String, // sha256 of the raw code: exact duplicates are visible without the engine
    /** Optional link to a judged Submission (contest/practice) this copy was taken from. */
    submissionId: oidRef('Submission'),
    checkStatus: { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    checkedAt: Date,
    checkError: String,
    maxSimilarity: { type: Number, default: 0 },
    submittedAt: { type: Date, default: Date.now },
  },
  opts,
);
codeSubmissionSchema.index({ scopeKey: 1, language: 1, userId: 1, submittedAt: -1 });
export const CodeSubmission = model('CodeSubmission', codeSubmissionSchema);

export const PLAGIARISM_STATUSES = ['clear', 'suspicious', 'confirmed'] as const;
const plagiarismPairSchema = new Schema(
  {
    scopeKey: { type: String, required: true },
    eventId: oidRef('Event'),
    problemId: oidRef('Problem'),
    language: { type: String, enum: PLAG_LANGS, required: true },
    aId: oidRef('CodeSubmission', { required: true }), // canonical order: String(aId) < String(bId)
    bId: oidRef('CodeSubmission', { required: true }),
    aUserId: oidRef('User', { required: true }),
    bUserId: oidRef('User', { required: true }),
    similarity: { type: Number, required: true, min: 0, max: 100 },
    winnowScore: { type: Number, default: 0 },
    jaccardScore: { type: Number, default: 0 },
    sharedPrints: { type: Number, default: 0 },
    status: { type: String, enum: PLAGIARISM_STATUSES, default: 'clear' },
    /** true once a reviewer set the status: re-runs and threshold changes then never overwrite it. */
    manual: { type: Boolean, default: false },
    thresholdUsed: Number,
    notes: [{ _id: false, authorId: oidRef('User'), authorName: String, text: { type: String, maxlength: 2000 }, at: { type: Date, default: Date.now } }],
    reviewedBy: oidRef('User'),
    reviewedAt: Date,
    /** set once, atomically, when organisers were told about this pair (one notice per pair, ever) */
    notifiedAt: Date,
    checkedAt: { type: Date, default: Date.now },
  },
  opts,
);
plagiarismPairSchema.index({ aId: 1, bId: 1 }, { unique: true });
plagiarismPairSchema.index({ scopeKey: 1, similarity: -1 });
plagiarismPairSchema.index({ status: 1, similarity: -1 });
plagiarismPairSchema.index({ bId: 1 });
export const PlagiarismPair = model('PlagiarismPair', plagiarismPairSchema);

/** Suspicious-threshold override. Resolution: problem -> event -> global -> built-in default (70). */
const plagiarismSettingSchema = new Schema(
  {
    scope: { type: String, enum: ['global', 'event', 'problem'], required: true },
    refId: { type: Schema.Types.ObjectId }, // absent for global
    suspiciousThreshold: { type: Number, required: true, min: 1, max: 100 },
    updatedBy: oidRef('User'),
  },
  opts,
);
plagiarismSettingSchema.index({ scope: 1, refId: 1 }, { unique: true });
export const PlagiarismSetting = model('PlagiarismSetting', plagiarismSettingSchema);

/** Template / starter code handed out with a problem or event: its token k-grams are excluded from every comparison in that scope. */
const starterCodeSchema = new Schema(
  {
    scopeKey: { type: String, required: true, index: true },
    eventId: oidRef('Event'),
    problemId: oidRef('Problem'),
    language: { type: String, enum: PLAG_LANGS, required: true },
    name: { type: String, default: 'Starter code', maxlength: 120 },
    code: { type: String, required: true },
    createdBy: oidRef('User'),
  },
  opts,
);
export const StarterCode = model('StarterCode', starterCodeSchema);

// ---------- AI feedback + review rubrics (S13) ----------
/** Grading rubric for code feedback, per event or per problem (`scopeKey` = `p:<problemId>` else `e:<eventId>`). Separate from the judging `Rubric` (per activity). */
const reviewRubricSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    scopeKey: { type: String, required: true, index: true },
    eventId: oidRef('Event'),
    problemId: oidRef('Problem'),
    criteria: [
      {
        _id: false,
        key: { type: String, required: true },
        name: { type: String, required: true, maxlength: 80 },
        description: { type: String, maxlength: 300 },
        maxPoints: { type: Number, required: true, min: 1, max: 1000 },
        weight: { type: Number, default: 1, min: 0, max: 100 },
      },
    ],
    active: { type: Boolean, default: true },
    createdBy: oidRef('User'),
  },
  opts,
);
reviewRubricSchema.index({ scopeKey: 1, name: 1 }, { unique: true });
export const ReviewRubric = model('ReviewRubric', reviewRubricSchema);

/** Feedback on one CodeSubmission (one per submission). `draft` is staff-only; participants only ever see `published`. */
const feedbackSchema = new Schema(
  {
    codeSubmissionId: oidRef('CodeSubmission', { required: true, unique: true }),
    userId: oidRef('User', { required: true, index: true }), // the participant
    eventId: oidRef('Event'),
    problemId: oidRef('Problem'),
    rubricId: oidRef('ReviewRubric'),
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    strengths: { type: [String], default: [] },
    issues: { type: [String], default: [] },
    suggestions: { type: [String], default: [] },
    quality: { rating: { type: Number, min: 1, max: 10 }, summary: { type: String, default: '', maxlength: 600 } },
    complexity: { time: { type: String, default: '', maxlength: 120 }, space: { type: String, default: '', maxlength: 120 }, notes: { type: String, default: '', maxlength: 600 } },
    /** Snapshot of the rubric criteria at generation time, so later rubric edits never change an issued score. */
    criterionScores: [
      { _id: false, key: String, name: String, maxPoints: Number, weight: Number, score: { type: Number, default: 0 }, comment: { type: String, default: '', maxlength: 600 } },
    ],
    total: { points: { type: Number, default: 0 }, maxPoints: { type: Number, default: 0 }, percent: { type: Number, default: 0 } },
    generation: {
      source: { type: String, enum: ['ai', 'manual'], default: 'manual' },
      model: String,
      truncated: { type: Boolean, default: false },
      ok: { type: Boolean, default: true },
      warnings: { type: [String], default: [] },
      at: Date,
    },
    editedBy: oidRef('User'),
    editedAt: Date,
    publishedBy: oidRef('User'),
    publishedAt: Date,
    createdBy: oidRef('User'),
  },
  opts,
);
feedbackSchema.index({ userId: 1, status: 1, publishedAt: -1 });
feedbackSchema.index({ eventId: 1, status: 1 });
export const Feedback = model('Feedback', feedbackSchema);

// ---------- Leaderboard (S15) ----------
/** Per-event leaderboard settings (weights, plagiarism penalty, tie-break) + whether non-staff may see it. One row per event; the scores themselves are never stored (always computed from judge scores, feedback and confirmed plagiarism pairs). */
const leaderboardSettingSchema = new Schema(
  {
    eventId: oidRef('Event', { required: true, unique: true }),
    judgeWeight: { type: Number, default: 70, min: 0, max: 100 },
    aiWeight: { type: Number, default: 30, min: 0, max: 100 },
    penaltyPerPair: { type: Number, default: 10, min: 0, max: 100 },
    maxPenalty: { type: Number, default: 50, min: 0, max: 100 },
    tieBreak: { type: String, enum: ['judge', 'ai', 'none'], default: 'judge' },
    published: { type: Boolean, default: false },
    updatedBy: oidRef('User'),
  },
  opts,
);
export const LeaderboardSetting = model('LeaderboardSetting', leaderboardSettingSchema);

export type Id = Types.ObjectId | string;
export { mongoose };

// ---------- Short-lived resource locks (see services/lock.ts) ----------
const resourceLockSchema = new Schema({
  key: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
resourceLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 }); // housekeeping only; correctness uses the lease check in lock.ts
export const ResourceLock = model('ResourceLock', resourceLockSchema);
