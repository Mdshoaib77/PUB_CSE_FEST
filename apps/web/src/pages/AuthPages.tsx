import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ArrowRight, BadgeCheck, Briefcase, CheckCircle2, ChevronDown, ClipboardCheck, Eye, EyeOff, Gavel, GraduationCap, HandHelping, Loader2, Lock, Mail, ScanLine, Ticket, Trophy, User as UserIcon, type LucideIcon } from 'lucide-react';
import { JUDGE_DESIGNATIONS, JUDGE_DESIGNATION_LABELS, loginSchema, registerSchema, type LoginInput, type RegisterInput, type RequestableRole } from '@festhub/shared';
import { useAuth } from '../lib/auth';
import { errMsg } from '../lib/api';
import { BANNER_SM_SRC, BANNER_SRC, BrandLockup, BrandMark, EVENT_NAME, UNIVERSITY_NAME } from '../components/Brand';

// ====================================================================== brand panel
let introPlayed = false; // play the entrance once per visit; switching Login ⇄ Register shouldn't replay it

function BrandPanel() {
  const skip = introPlayed;
  const enter = (d: number) => ({ initial: skip ? false : { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { delay: skip ? 0 : d, duration: 0.5, ease: 'easeOut' as const } });
  const features: [LucideIcon, string][] = [
    [Ticket, 'The waiting list promotes itself the moment a seat frees up'],
    [ScanLine, 'Check-in QR codes that refresh, so screenshots can’t be shared'],
    [Trophy, 'Contest scoreboards that freeze fairly and reveal on cue'],
  ];
  return (
    <section className="relative isolate overflow-hidden bg-ink-950 px-6 pb-24 pt-6 text-white sm:px-10 lg:flex lg:h-full lg:flex-col lg:justify-between lg:gap-6 lg:px-10 lg:py-[clamp(1.25rem,4vh,2.5rem)] xl:px-14">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
        <picture>
          <source media="(max-width: 767px)" srcSet={BANNER_SM_SRC} />
          <img src={BANNER_SRC} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover object-[55%_50%]" />
        </picture>
        <div className="absolute inset-0 bg-gradient-to-b from-ink-950/90 via-ink-950/80 to-ink-950/95 lg:bg-gradient-to-br lg:from-ink-950/95 lg:via-ink-950/80 lg:to-brand-900/70" />
        <div className="absolute -left-32 -top-32 h-[30rem] w-[30rem] rounded-full bg-brand-700/45 blur-[120px]" />
        <div className="absolute -bottom-40 right-0 h-[28rem] w-[28rem] rounded-full bg-coral-500/15 blur-[120px]" />
        <div className="absolute inset-y-0 right-0 hidden w-px bg-gradient-to-b from-transparent via-gold-400/50 to-transparent lg:block" />
      </div>

      <BrandLockup to="/" tone="light" />

      <div className="mt-8 max-w-xl lg:mt-0">
        <motion.div {...enter(0)} className="relative mb-[clamp(0.75rem,2.5vh,1.5rem)] w-fit">
          <span aria-hidden className="absolute inset-0 -z-10 scale-110 animate-glow-pulse rounded-full bg-brand-500/50 blur-3xl" />
          <BrandMark size={176} fluid priority className="h-24 sm:h-32 lg:h-[clamp(5rem,20vh,11rem)]" />
          <span className="sr-only">{EVENT_NAME}</span>
        </motion.div>
        <motion.p {...enter(0.02)} className="font-ui text-xs font-semibold uppercase tracking-[0.18em] text-gold-300">
          Events · Contests · Volunteers
        </motion.p>
        <motion.h1 {...enter(0.08)} className="mt-4 font-display text-[1.9rem] font-bold leading-[1.1] sm:text-5xl lg:mt-[clamp(0.5rem,1.5vh,1rem)] lg:text-[clamp(1.9rem,2.6vw+0.4rem,3.4rem)]">
          One place for every seat, shift and score.
        </motion.h1>
        <motion.p {...enter(0.16)} className="mt-5 max-w-md text-base leading-relaxed text-white/70 lg:mt-[clamp(0.5rem,2vh,1.25rem)] tiny:lg:hidden">
          Registrations, volunteer rosters, QR check-in and live programming contests for {UNIVERSITY_NAME}, on one platform.
        </motion.p>
        <ul className="mt-8 hidden space-y-3.5 lg:block short:hidden">
          {features.map(([Icon, text], i) => (
            <motion.li key={text} {...enter(0.26 + i * 0.08)} className="flex items-center gap-3 text-sm text-white/85">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gold-400/30 bg-white/5 text-gold-300">
                <Icon size={16} />
              </span>
              {text}
            </motion.li>
          ))}
        </ul>
      </div>

      <p className="relative hidden text-xs text-white/45 lg:block">© {new Date().getFullYear()} {UNIVERSITY_NAME}</p>
    </section>
  );
}

// ====================================================================== form parts
type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; icon: LucideIcon; error?: string; valid?: boolean; trailing?: ReactNode };
const AuthInput = forwardRef<HTMLInputElement, InputProps>(function AuthInput({ label, icon: Icon, error, valid, trailing, id, className = '', ...rest }, ref) {
  const eid = `${id}-err`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <motion.div key={error ?? 'ok'} animate={error ? { x: [0, -7, 7, -4, 4, 0] } : { x: 0 }} transition={{ duration: 0.38 }} className="group relative">
        <Icon size={17} className={`pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 transition-colors ${error ? 'text-red-500' : valid ? 'text-emerald-500' : 'text-slate-500 group-focus-within:text-brand-600'}`} />
        <input
          ref={ref}
          id={id}
          aria-invalid={!!error}
          aria-describedby={error ? eid : undefined}
          className={`w-full rounded-lg border bg-white py-2.5 pl-10 short:lg:py-2 pr-11 text-sm text-slate-900 shadow-[inset_0_1px_2px_rgba(10,18,48,0.04)] transition duration-200 placeholder:text-slate-400 focus:outline-none focus:ring-4 ${
            error ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15' : valid ? 'border-emerald-400/80 focus:border-emerald-500 focus:ring-emerald-500/15' : 'border-slate-300/70 hover:border-slate-400/70 focus:border-brand-500 focus:ring-brand-500/15'
          } ${className}`}
          {...rest}
        />
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <AnimatePresence mode="wait" initial={false}>
            {error ? (
              <motion.span key="e" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="text-red-500">
                <AlertCircle size={17} />
              </motion.span>
            ) : valid ? (
              <motion.span key="v" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="text-emerald-500">
                <CheckCircle2 size={17} />
              </motion.span>
            ) : null}
          </AnimatePresence>
          {trailing}
        </div>
      </motion.div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.p id={eid} role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pt-1 text-xs font-medium text-red-600">
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; icon: LucideIcon; error?: string };
const AuthSelect = forwardRef<HTMLSelectElement, SelectProps>(function AuthSelect({ label, icon: Icon, error, id, children, ...rest }, ref) {
  const eid = `${id}-err`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <motion.div key={error ?? 'ok'} animate={error ? { x: [0, -7, 7, -4, 4, 0] } : { x: 0 }} transition={{ duration: 0.38 }} className="group relative">
        <Icon size={17} className={`pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 transition-colors ${error ? 'text-red-500' : 'text-slate-500 group-focus-within:text-brand-600'}`} />
        <select
          ref={ref}
          id={id}
          aria-invalid={!!error}
          aria-describedby={error ? eid : undefined}
          className={`w-full appearance-none rounded-lg border bg-white py-2.5 pl-10 pr-10 short:lg:py-2 text-sm text-slate-900 shadow-[inset_0_1px_2px_rgba(10,18,48,0.04)] transition duration-200 focus:outline-none focus:ring-4 ${
            error ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15' : 'border-slate-300/70 hover:border-slate-400/70 focus:border-brand-500 focus:ring-brand-500/15'
          }`}
          {...rest}>
          {children}
        </select>
        <ChevronDown size={16} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
      </motion.div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.p id={eid} role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pt-1 text-xs font-medium text-red-600">
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
});

function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-label={shown ? 'Hide password' : 'Show password'} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
      {shown ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <motion.button
      type="submit"
      disabled={busy}
      whileHover={busy ? undefined : { y: -2 }}
      whileTap={busy ? undefined : { scale: 0.98 }}
      className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-brand-700 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-ink-900/20 transition duration-200 hover:bg-brand-800 hover:shadow-lg disabled:opacity-80">
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1/3 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent group-hover:animate-sheen" />
      {busy ? <Loader2 size={17} className="animate-spin" /> : null}
      <span className="relative">{children}</span>
      {!busy && <ArrowRight size={16} className="relative transition-transform duration-200 group-hover:translate-x-1" />}
    </motion.button>
  );
}

const formVariants = { hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } } };
const fieldVariants = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 220, damping: 22 } } };

function FormCard({ title, sub, children, footer }: { title: string; sub: string; children: ReactNode; footer: ReactNode }) {
  return (
    <section className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-8 lg:min-h-full lg:px-10 lg:py-6">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
        <div className="absolute -right-24 top-10 h-80 w-80 rounded-full bg-brand-300/25 blur-[100px]" />
        <div className="absolute -left-10 bottom-0 h-72 w-72 rounded-full bg-coral-400/15 blur-[100px]" />
      </div>
      <motion.div initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 130, damping: 20 }} className="glass-strong w-full max-w-[27rem] p-6 sm:p-9 lg:p-[clamp(1.25rem,3.4vh,2.25rem)] xl:max-w-[29rem]">
        <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-500 tiny:hidden">{sub}</p>
        <div className="mt-6 lg:mt-[clamp(0.75rem,2.5vh,1.5rem)]">{children}</div>
        <div className="mt-6 border-t lg:mt-[clamp(0.75rem,2.5vh,1.5rem)] border-slate-200/70 pt-4 text-center text-sm text-slate-500">{footer}</div>
      </motion.div>
    </section>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  // mark the intro as played after it has run, so a Login ⇄ Register switch doesn't replay it
  useEffect(() => {
    const t = setTimeout(() => (introPlayed = true), 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex min-h-screen flex-col lg:grid lg:h-[100svh] lg:min-h-0 lg:grid-cols-[1.05fr_1fr] lg:overflow-hidden">
      <BrandPanel />
      <div className="-mt-14 flex flex-1 flex-col lg:mt-0 lg:min-h-0 lg:overflow-y-auto">{children}</div>
    </div>
  );
}

const ServerError = ({ message }: { message: string }) => (
  <AnimatePresence>
    {message && (
      <motion.div initial={{ opacity: 0, height: 0, y: -6 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden" role="alert">
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50/90 px-3 py-2.5 text-sm text-red-800">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {message}
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);

// ====================================================================== Login
export function Login() {
  const { login, user } = useAuth();
  const loc = useLocation();
  const [err, setErr] = useState('');
  const [show, setShow] = useState(false);
  const f = useForm<LoginInput>({ resolver: zodResolver(loginSchema), mode: 'onTouched', defaultValues: { email: '', password: '' } });
  const { errors, touchedFields, isSubmitting } = f.formState;
  const [email] = f.watch(['email']);
  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={from} replace />;
  return (
    <AuthShell>
      <FormCard
        title="Welcome back"
        sub="Sign in to join events, run your shifts or manage the fest."
        footer={
          <>
            New here?{' '}
            <Link className="font-semibold text-brand-700 underline-offset-4 hover:underline" to="/register">
              Create an account
            </Link>
          </>
        }
      >
        <motion.form
          variants={formVariants}
          initial="hidden"
          animate="show"
          className="space-y-4 lg:space-y-[clamp(0.6rem,1.8vh,1rem)]"
          noValidate
          onSubmit={f.handleSubmit(async (v) => {
            setErr('');
            try {
              await login(v);
            } catch (e) {
              setErr(errMsg(e));
            }
          })}
        >
          <motion.div variants={fieldVariants}>
            <AuthInput id="email" label="Email" icon={Mail} type="email" autoComplete="email" placeholder="you@pub.edu" error={errors.email?.message} valid={!!touchedFields.email && !errors.email && !!email} {...f.register('email')} />
          </motion.div>
          <motion.div variants={fieldVariants}>
            <AuthInput
              id="password"
              label="Password"
              icon={Lock}
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Your password"
              error={errors.password?.message}
              trailing={<PasswordToggle shown={show} onToggle={() => setShow((s) => !s)} />}
              {...f.register('password')}
            />
          </motion.div>
          <ServerError message={err} />
          <motion.div variants={fieldVariants}>
            <SubmitButton busy={isSubmitting}>{isSubmitting ? 'Signing in…' : 'Sign in'}</SubmitButton>
          </motion.div>
        </motion.form>
      </FormCard>
    </AuthShell>
  );
}

// ====================================================================== Register
function strength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 14) s++;
  return pw.length === 0 ? 0 : Math.max(1, s);
}
const STRENGTH = [
  { label: '', bar: 'bg-slate-200' },
  { label: 'Too weak', bar: 'bg-red-500' },
  { label: 'Okay', bar: 'bg-amber-500' },
  { label: 'Good', bar: 'bg-lime-500' },
  { label: 'Strong', bar: 'bg-emerald-500' },
];

type Choice = 'participant' | 'volunteer' | RequestableRole;
/** Participant and Volunteer are direct roles; Judge and Coordinator are requests an organiser approves. */
const ROLE_OPTIONS: { value: Choice; label: string; hint: string; icon: LucideIcon; request?: boolean }[] = [
  { value: 'participant', label: 'Participant', hint: 'Join events and contests', icon: GraduationCap },
  { value: 'volunteer', label: 'Volunteer', hint: 'Help run the fest', icon: HandHelping },
  { value: 'judge', label: 'Judge', hint: 'Score entries and contests', icon: Gavel, request: true },
  { value: 'coordinator', label: 'Coordinator', hint: 'Help organise events', icon: ClipboardCheck, request: true },
];
const collapse = { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 }, transition: { duration: 0.22 } };

export function Register() {
  const { register: signUp, user } = useAuth();
  const [err, setErr] = useState('');
  const [show, setShow] = useState(false);
  const [choice, setChoice] = useState<Choice>('participant');
  const [created, setCreated] = useState<RequestableRole | null>(null); // set after a signup that asked for a staff role
  const holdRedirect = useRef(false); // signing up logs the user in; keep this page open long enough to show the approval message
  const f = useForm<RegisterInput>({ resolver: zodResolver(registerSchema), mode: 'onTouched', defaultValues: { name: '', email: '', password: '', role: 'participant', department: '', batch: '' } });
  const { errors, touchedFields, isSubmitting } = f.formState;
  const [name, email, pw, employeeId] = f.watch(['name', 'email', 'password', 'employeeId']);
  const score = strength(pw ?? '');
  const isJudge = choice === 'judge';
  const isRequest = choice === 'judge' || choice === 'coordinator';
  if (user && !created && !holdRedirect.current) return <Navigate to="/" replace />;
  const ok = (k: 'name' | 'email' | 'password' | 'employeeId', v?: string) => !!touchedFields[k] && !errors[k] && !!v;

  /** A request option signs up as a participant and sends `requestedRole`; a direct option sends `role`. */
  const pick = (c: Choice) => {
    setChoice(c);
    const req = c === 'judge' || c === 'coordinator';
    f.setValue('role', req ? 'participant' : c);
    f.setValue('requestedRole', req ? c : undefined);
    if (c !== 'judge') {
      f.setValue('designation', undefined);
      f.setValue('employeeId', undefined);
      f.clearErrors(['designation', 'employeeId']);
    } else {
      f.setValue('department', '');
      f.setValue('batch', '');
    }
  };

  if (created) {
    return (
      <AuthShell>
        <FormCard title="You’re in" sub="You’re signed in as a participant in the meantime." footer={<>An organiser will review your request.</>}>
          <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/90 px-4 py-3.5 text-sm text-emerald-900">
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-600" />
            <p className="font-medium">{`Account created. Your ${created} request is waiting for organiser approval.`}</p>
          </div>
          <Link to="/" className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-ink-900/20 transition duration-200 hover:bg-brand-800">
            Continue to FestHub <ArrowRight size={16} />
          </Link>
        </FormCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <FormCard
        title="Create your account"
        sub="It takes a minute. You can change how you take part later."
        footer={
          <>
            Already registered?{' '}
            <Link className="font-semibold text-brand-700 underline-offset-4 hover:underline" to="/login">
              Sign in
            </Link>
          </>
        }
      >
        <motion.form
          variants={formVariants}
          initial="hidden"
          animate="show"
          className="space-y-4 lg:space-y-[clamp(0.6rem,1.8vh,1rem)]"
          noValidate
          onSubmit={f.handleSubmit(async (v) => {
            setErr('');
            holdRedirect.current = !!v.requestedRole;
            try {
              await signUp(v);
              if (v.requestedRole) setCreated(v.requestedRole);
            } catch (x) {
              holdRedirect.current = false;
              setErr(errMsg(x));
            }
          })}
        >
          <motion.div variants={fieldVariants}>
            <AuthInput id="name" label="Full name" icon={UserIcon} autoComplete="name" placeholder="Ayesha Rahman" error={errors.name?.message} valid={ok('name', name)} {...f.register('name')} />
          </motion.div>
          <motion.div variants={fieldVariants}>
            <AuthInput id="email" label="Email" icon={Mail} type="email" autoComplete="email" placeholder="you@pub.edu" error={errors.email?.message} valid={ok('email', email)} {...f.register('email')} />
          </motion.div>
          <motion.div variants={fieldVariants}>
            <AuthInput
              id="password"
              label="Password"
              icon={Lock}
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              error={errors.password?.message}
              trailing={<PasswordToggle shown={show} onToggle={() => setShow((s) => !s)} />}
              {...f.register('password')}
            />
            <div className="mt-2 flex items-center gap-2" aria-live="polite">
              <div className="flex flex-1 gap-1" aria-hidden>
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <span className={`block h-full w-full origin-left rounded-full transition-transform duration-300 ${STRENGTH[Math.max(score, 1)].bar} ${i <= score ? 'scale-x-100' : 'scale-x-0'}`} />
                  </span>
                ))}
              </div>
              <span className="w-14 text-right text-xs font-medium text-slate-500">{STRENGTH[score].label}</span>
            </div>
          </motion.div>
          <motion.fieldset variants={fieldVariants}>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">I’m joining as</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {ROLE_OPTIONS.map((o) => {
                const on = choice === o.value;
                return (
                  <label key={o.value} className={`relative flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 transition focus-within:ring-4 focus-within:ring-brand-500/15 ${on ? 'border-transparent' : 'border-slate-300/70 bg-white/60 hover:border-brand-300'}`}>
                    {on && <motion.span layoutId="role-ring" className="absolute inset-0 rounded-xl border-2 border-brand-500 bg-brand-50/80" transition={{ type: 'spring', stiffness: 450, damping: 34 }} />}
                    <input type="radio" className="sr-only" name="joinAs" value={o.value} checked={on} onChange={() => pick(o.value)} />
                    <span className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-lg ${on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                      <o.icon size={16} />
                    </span>
                    <span className="relative min-w-0 leading-tight">
                      <span className="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-slate-900">
                        {o.label}
                        {o.request && <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800">Request</span>}
                      </span>
                      <span className="block text-[11px] text-slate-500">{o.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className={`mt-1.5 text-xs transition-colors ${isRequest ? 'font-medium text-amber-700' : 'text-slate-500 short:hidden'}`}>
              <span className="font-semibold">Judge and Coordinator:</span> Needs organiser approval. You join as a participant until approved.
            </p>
          </motion.fieldset>
          <motion.div variants={fieldVariants} className="-m-1">
            <AnimatePresence initial={false} mode="wait">
              {isJudge ? (
                <motion.div key="judge" {...collapse} className="overflow-hidden p-1">
                  <div className="space-y-3 lg:space-y-[clamp(0.5rem,1.5vh,0.75rem)]">
                    <AuthSelect id="designation" label="Designation" icon={Briefcase} defaultValue="" error={errors.designation?.message} {...f.register('designation', { setValueAs: (v: string) => v || undefined })}>
                      <option value="" disabled>
                        Select your designation
                      </option>
                      {JUDGE_DESIGNATIONS.map((d) => (
                        <option key={d} value={d}>
                          {JUDGE_DESIGNATION_LABELS[d]}
                        </option>
                      ))}
                    </AuthSelect>
                    <AuthInput
                      id="employeeId"
                      label="Teacher / Employee ID"
                      icon={BadgeCheck}
                      autoComplete="off"
                      placeholder="e.g. EMP-1024"
                      error={errors.employeeId?.message}
                      valid={ok('employeeId', employeeId)}
                      {...f.register('employeeId', { setValueAs: (v: string) => v?.trim() || undefined })}
                    />
                  </div>
                </motion.div>
              ) : (
                <motion.div key="dept" {...collapse} className="overflow-hidden p-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="department" className="mb-1.5 block text-sm font-medium text-slate-700">
                        Department
                      </label>
                      <input id="department" className="input" placeholder="CSE" {...f.register('department')} />
                    </div>
                    <div>
                      <label htmlFor="batch" className="mb-1.5 block text-sm font-medium text-slate-700">
                        Batch
                      </label>
                      <input id="batch" className="input" placeholder="2022" {...f.register('batch')} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          <ServerError message={err} />
          <motion.div variants={fieldVariants}>
            <SubmitButton busy={isSubmitting}>{isSubmitting ? 'Creating account…' : isRequest ? 'Create account and send request' : 'Create account'}</SubmitButton>
          </motion.div>
        </motion.form>
      </FormCard>
    </AuthShell>
  );
}
