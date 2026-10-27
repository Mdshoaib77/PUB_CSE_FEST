import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Loader2, Plus } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useDelete, useGet } from '../lib/hooks';
import { venueCapacity, type VenueLike } from '../lib/venue';
import { TrashButton, useToast } from './ui';

/**
 * Add / delete venues (organiser/admin only; the server enforces the role too). Name required (2-80, unique ignoring case),
 * capacity and building optional (building is never hard-coded). Deleting asks for confirmation; events/activities that use
 * the venue are unlinked by the server (no event is left pointing to a missing venue).
 */
export function VenueManager({ onAdded }: { onAdded?: (id: string) => void }) {
  const venues = useGet<VenueLike[]>('/venues');
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [building, setBuilding] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const del = useDelete({ noun: 'venue', request: (id) => api.del(`/venues/${id}`), prune: ['/venues'], invalidate: ['/venues', '/events', '/me/dashboard'] });

  const submit = async () => {
    const n = name.trim();
    if (n.length < 2) return setErr('Venue name must be at least 2 characters');
    if (n.length > 80) return setErr('Venue name must be at most 80 characters');
    const cap = capacity.trim();
    if (cap && !(Number.isInteger(Number(cap)) && Number(cap) >= 1)) return setErr('Capacity must be a whole number of at least 1, or empty');
    if ((venues.data ?? []).some((v) => v.name.trim().toLowerCase() === n.toLowerCase())) return setErr(`A venue named "${n}" already exists`);
    setBusy(true);
    setErr(null);
    try {
      const v = await api.post<{ _id: string }>('/venues', { name: n, ...(cap ? { capacity: Number(cap) } : {}), ...(building.trim() ? { building: building.trim() } : {}) });
      await qc.invalidateQueries({ queryKey: ['/venues'] });
      toast('Venue added', 'ok');
      setName('');
      setCapacity('');
      setBuilding('');
      onAdded?.(v._id);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <button type="button" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-300" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Building2 size={14} /> {open ? 'Hide venue manager' : 'Manage venues'}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-white/5">
          <div className="flex flex-wrap gap-2">
            <input className="input min-w-[9rem] flex-1" placeholder="Venue name *" maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} aria-label="New venue name" aria-invalid={!!err} />
            <input className="input w-28" type="number" min={1} step={1} placeholder="Capacity" value={capacity} onChange={(e) => { setCapacity(e.target.value); setErr(null); }} aria-label="Capacity (optional)" />
            <input className="input min-w-[8rem] flex-1" placeholder="Building (optional)" maxLength={80} value={building} onChange={(e) => setBuilding(e.target.value)} aria-label="Building (optional)" />
            <button type="button" className="btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add venue
            </button>
          </div>
          {err && <p role="alert" className="mt-1.5 text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="mt-3 max-h-56 overflow-y-auto">
            {venues.isLoading && <p className="text-sm text-slate-500">Loading venues…</p>}
            {venues.isError && <p role="alert" className="text-sm text-red-600">Could not load venues: {errMsg(venues.error)}</p>}
            {venues.data && venues.data.length === 0 && <p className="text-sm text-slate-500">No venues yet. Add the first one above.</p>}
            <ul className="divide-y divide-slate-100 text-sm dark:divide-white/10">
              {venues.data?.map((v) => {
                const c = venueCapacity(v);
                return (
                  <li key={v._id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 break-words">
                      {v.name}
                      {c ? <span className="text-slate-500"> · capacity {c}</span> : null}
                    </span>
                    <TrashButton label={`Delete venue ${v.name}`} onClick={() => void del({ id: v._id, name: v.name, warning: 'Events and activities that use this venue will be left without a venue. Nothing else is deleted.' })} />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
