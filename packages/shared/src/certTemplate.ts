/**
 * Certificate template options (v6): pure constants, length limits, validation schema and placeholder replacement.
 * Shared by the server (validation + PDF renderer) and the web editor (maxLength on inputs, placeholder chips).
 * Every text field has a hard limit here so a certificate layout can never overflow.
 */
import { z } from 'zod';
import { CERTIFICATE_TYPES, type CertificateType } from './certificates';

export const CERT_TEMPLATE_THEMES = ['royal', 'emerald', 'sunset', 'violet', 'custom'] as const;
export type CertTemplateTheme = (typeof CERT_TEMPLATE_THEMES)[number];
/** Preset palettes (also used by the PDF renderer, so the editor swatches always match the printed result). */
export const CERT_THEME_COLORS = {
  royal: { label: 'Royal Blue & Gold', primary: '#1e3a8a', accent: '#c9a227' },
  emerald: { label: 'Emerald & Gold', primary: '#065f46', accent: '#c9a227' },
  sunset: { label: 'Sunset', primary: '#c2410c', accent: '#e8890c' },
  violet: { label: 'Violet', primary: '#5b21b6', accent: '#c026d3' },
} as const;
export const CERT_BORDER_STYLES = ['classic', 'modern', 'minimal'] as const;
export type CertBorderStyle = (typeof CERT_BORDER_STYLES)[number];
export const CERT_FONT_STYLES = ['serif', 'sans'] as const;
export type CertFontStyle = (typeof CERT_FONT_STYLES)[number];
export const CERT_PLACEHOLDERS = ['name', 'team', 'members', 'event', 'position', 'date', 'venue'] as const;
export type CertPlaceholder = (typeof CERT_PLACEHOLDERS)[number];

export const CERT_TEMPLATE_LIMITS = {
  signatories: 3,
  signatoryName: 40,
  signatoryTitle: 80,
  headline: 50,
  bodyText: 280,
  /** Longest body paragraph ever drawn, after placeholders were replaced (e.g. a team of 20). */
  bodyRendered: 600,
  fields: 4,
  fieldLabel: 24,
  fieldValue: 48,
  /** label + value characters of ALL custom fields together (they share one strip). */
  fieldsTotal: 150,
} as const;

export const CERT_SAMPLE_KINDS = ['individual', 'team3', 'team8', 'winner'] as const;
export type CertSampleKind = (typeof CERT_SAMPLE_KINDS)[number];

/** Remove control characters, collapse all whitespace (no line breaks in any field) and trim. */
// eslint-disable-next-line no-control-regex
export const cleanTemplateText = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** `{token}` names found in a text that are not a known placeholder. */
export function unknownPlaceholders(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) if (!(CERT_PLACEHOLDERS as readonly string[]).includes(m[1]) && !bad.includes(m[1])) bad.push(m[1]);
  return bad;
}

export type PlaceholderValues = Partial<Record<CertPlaceholder, string>>;
/**
 * Replace {name} {team} {members} {event} {position} {date} {venue}. Missing / empty values become '' (e.g. {team} on an
 * individual certificate); the result is tidied (double spaces, space before punctuation) and capped at `max` characters.
 */
export function applyPlaceholders(text: string, values: PlaceholderValues, max: number = CERT_TEMPLATE_LIMITS.bodyRendered): string {
  const out = cleanTemplateText(text)
    .replace(/\{([^{}]*)\}/g, (all, k: string) =>
      (CERT_PLACEHOLDERS as readonly string[]).includes(k) ? cleanTemplateText(values[k as CertPlaceholder] ?? '') : all,
    )
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out.length > max ? `${out.slice(0, Math.max(0, max - 3)).trimEnd()}...` : out;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const text = (max: number, what: string) =>
  z
    .string({ invalid_type_error: `${what} must be text` })
    .transform(cleanTemplateText)
    .refine((s) => s.length <= max, { message: `${what} can be at most ${max} characters` });

export const certTemplateBodySchema = text(CERT_TEMPLATE_LIMITS.bodyText, 'Body text').refine((s) => unknownPlaceholders(s).length === 0, {
  message: `Unknown placeholder. Use ${CERT_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`,
});

const signatory = z
  .object({ name: text(CERT_TEMPLATE_LIMITS.signatoryName, 'Signatory name'), title: text(CERT_TEMPLATE_LIMITS.signatoryTitle, 'Signatory title') })
  .strict();
const field = z.object({ label: text(CERT_TEMPLATE_LIMITS.fieldLabel, 'Field label'), value: text(CERT_TEMPLATE_LIMITS.fieldValue, 'Field value') }).strict();

/** Body of PUT /events/:id/certificate-template and of the preview endpoint. Every key is optional (partial update). Unknown keys are rejected. */
export const certTemplateInputSchema = z
  .object({
    theme: z.enum(CERT_TEMPLATE_THEMES),
    primaryColor: z.string().regex(HEX, 'Use a colour like #4f46e5'),
    accentColor: z.string().regex(HEX, 'Use a colour like #d94c33'),
    borderStyle: z.enum(CERT_BORDER_STYLES),
    fontStyle: z.enum(CERT_FONT_STYLES),
    sealEnabled: z.boolean(),
    // legacy single-signatory fields (S6): still accepted, they edit signatory 1
    signatureName: text(CERT_TEMPLATE_LIMITS.signatoryName, 'Signatory name'),
    signatureTitle: text(CERT_TEMPLATE_LIMITS.signatoryTitle, 'Signatory title'),
    signatories: z.array(signatory).max(CERT_TEMPLATE_LIMITS.signatories, `At most ${CERT_TEMPLATE_LIMITS.signatories} signatories`),
    headlines: z
      .object(
        Object.fromEntries(CERTIFICATE_TYPES.map((t) => [t, text(CERT_TEMPLATE_LIMITS.headline, 'Headline').optional()])) as Record<
          CertificateType,
          z.ZodOptional<ReturnType<typeof text>>
        >,
      )
      .strict(),
    bodyText: certTemplateBodySchema,
    customFields: z
      .array(field)
      .max(CERT_TEMPLATE_LIMITS.fields, `At most ${CERT_TEMPLATE_LIMITS.fields} custom fields`)
      .transform((rows) => rows.filter((f) => f.label || f.value))
      .refine((rows) => rows.every((f) => f.label && f.value), { message: 'Each custom field needs both a label and a value' })
      .refine((rows) => rows.reduce((n, f) => n + f.label.length + f.value.length, 0) <= CERT_TEMPLATE_LIMITS.fieldsTotal, {
        message: `Custom fields are too long together (max ${CERT_TEMPLATE_LIMITS.fieldsTotal} characters of labels and values)`,
      }),
  })
  .partial(); // unknown keys are stripped (older clients keep working)
export type CertTemplateInput = z.infer<typeof certTemplateInputSchema>;
