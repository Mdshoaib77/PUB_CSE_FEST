import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';
import { EVENT_TYPES, eventSchema } from '@festhub/shared';
import { api } from '../lib/api';
import { toLocalInput, useAct, useGet } from '../lib/hooks';
import { Card, Field, PageHeader, Skeleton } from '../components/ui';
import CoverPicker from '../components/CoverPicker';
import { VenueManager } from '../components/VenueManager';
import { venueLabel, type VenueLike } from '../lib/venue';
import { useAuth } from '../lib/auth';

// Form-level schema: dates are edited as strings in <input type="datetime-local">.
const formSchema = eventSchema.extend({
  eligibility: z.object({ department: z.string().optional(), batch: z.string().optional(), notes: z.string().optional() }),
});
type FormIn = z.input<typeof formSchema>;

export default function EventForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { has } = useAuth();
  const existing = useGet<Record<string, never>>(id ? `/events/${id}` : null);
  const venues = useGet<VenueLike[]>('/venues');
  const f = useForm<FormIn>({
    resolver: zodResolver(formSchema),
    defaultValues: { type: 'seminar', participationType: 'individual', capacity: 50, teamSize: { min: 1, max: 1 }, requiresApproval: false, eligibility: {}, imageUrl: '' },
  });
  useEffect(() => {
    const e = existing.data as unknown as Record<string, unknown> | undefined;
    if (e)
      f.reset({
        ...(e as object),
        startAt: toLocalInput(e.startAt as string) as never,
        endAt: toLocalInput(e.endAt as string) as never,
        registrationDeadline: toLocalInput(e.registrationDeadline as string) as never,
        venueId: (e.venueId as string) ?? '',
        eligibility: (e.eligibility as never) ?? {},
        imageUrl: (e.imageUrl as string) ?? '',
      });
  }, [existing.data]);
  const save = useAct(
    (v: FormIn) => {
      const body = { ...v, venueId: v.venueId || undefined, imageUrl: v.imageUrl ?? '' }; // '' tells the API to clear the cover
      return id ? api.patch<{ _id: string }>(`/events/${id}`, body) : api.post<{ _id: string }>('/events', body);
    },
    { ok: 'Event saved', onDone: (r) => nav(`/events/${(r as { _id: string })._id}`) },
  );
  const e = f.formState.errors;
  const team = f.watch('participationType') === 'team';
  const [title, type, imageUrl] = f.watch(['title', 'type', 'imageUrl']);
  if (id && existing.isLoading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  return (
    <>
      <PageHeader title={id ? 'Edit event' : 'Create event'} sub="Events are saved as drafts. Publish them from the event page." />
      <form className="space-y-5" onSubmit={f.handleSubmit((v) => save.mutate(v))} noValidate>
        <Card className="!p-5">
          <h2 className="mb-3 text-lg font-semibold">Cover image</h2>
          <CoverPicker value={imageUrl ?? ''} onChange={(v) => f.setValue('imageUrl', v, { shouldDirty: true, shouldValidate: true })} title={title ?? ''} type={type ?? 'seminar'} />
          {e.imageUrl?.message && <p className="mt-2 text-sm text-red-600">{e.imageUrl.message as string}</p>}
        </Card>
        <Card className="!p-5">
          <h2 className="mb-3 text-lg font-semibold">Details</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field label="Title" error={e.title?.message}>
                <input className="input" {...f.register('title')} />
              </Field>
            </div>
            <Field label="Type">
              <select className="input" {...f.register('type')}>
                {EVENT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Venue">
              <select className="input" {...f.register('venueId')}>
                <option value="">— none —</option>
                {venues.data?.map((v) => (
                  <option key={v._id} value={v._id}>
                    {venueLabel(v)}
                  </option>
                ))}
              </select>
              {has('organiser') && <VenueManager onAdded={(vid) => setTimeout(() => f.setValue('venueId', vid, { shouldDirty: true }), 300)} />}
            </Field>
            <div className="md:col-span-2">
              <Field label="Description">
                <textarea className="input" rows={4} {...f.register('description')} />
              </Field>
            </div>
            <Field label="Starts" error={e.startAt?.message as string}>
              <input className="input" type="datetime-local" {...f.register('startAt')} />
            </Field>
            <Field label="Ends" error={e.endAt?.message as string}>
              <input className="input" type="datetime-local" {...f.register('endAt')} />
            </Field>
            <Field label="Registration deadline" error={e.registrationDeadline?.message as string}>
              <input className="input" type="datetime-local" {...f.register('registrationDeadline')} />
            </Field>
            <Field label="Participant limit" error={e.capacity?.message as string}>
              <input className="input" type="number" min={1} {...f.register('capacity')} />
            </Field>
            <Field label="Participation">
              <select className="input" {...f.register('participationType')}>
                <option value="individual">Individual</option>
                <option value="team">Team</option>
              </select>
            </Field>
            {team && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Min team size">
                  <input className="input" type="number" min={1} {...f.register('teamSize.min')} />
                </Field>
                <Field label="Max team size">
                  <input className="input" type="number" min={1} {...f.register('teamSize.max')} />
                </Field>
              </div>
            )}
            <Field label="Eligible department (optional)">
              <input className="input" placeholder="CSE" {...f.register('eligibility.department')} />
            </Field>
            <Field label="Eligible batch (optional)">
              <input className="input" {...f.register('eligibility.batch')} />
            </Field>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" className="h-4 w-4 rounded accent-brand-600" {...f.register('requiresApproval')} /> Registrations need organiser/coordinator approval
            </label>
          </div>
        </Card>
        <div className="flex gap-2">
          <button className="btn-primary !px-6 !py-2.5" disabled={save.isPending}>
            {save.isPending && <Loader2 size={15} className="animate-spin" />}
            {save.isPending ? 'Saving…' : 'Save event'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => nav(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
