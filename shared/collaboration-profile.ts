import { z } from 'zod';

export class CollaborationReferenceError extends Error {}

export const collaborationProfileSchema = z.object({
  basis: z.enum(['declared', 'provided_assessment']),
  source_label: z.string().trim().min(3).max(300),
  recorded_on: z.string().date().nullable(),
  soft_skills: z.array(z.string().trim().min(1).max(80)).max(16),
  working_preferences: z.string().trim().max(1500),
  psychometric_method: z.string().trim().min(1).max(160).nullable(),
  psychometric_summary: z.string().trim().min(1).max(2500).nullable(),
  compatibility: z.array(z.object({ member_id: z.string().min(1).max(120), note: z.string().trim().min(3).max(1200) }).strict()).max(30),
}).strict().superRefine((value, ctx) => {
  if (value.psychometric_summary && (value.basis !== 'provided_assessment' || !value.psychometric_method)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Evaluarea psihometrică necesită metoda și o evaluare furnizată.', path: ['psychometric_summary'] });
  }
  if (new Set(value.compatibility.map(item => item.member_id)).size !== value.compatibility.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Folosește o singură notă pentru fiecare coleg.', path: ['compatibility'] });
  }
});

export function validateCollaborationReferences(profile: z.infer<typeof collaborationProfileSchema> | null | undefined, members: readonly { id: string }[], ownId?: string) {
  if (!profile) return;
  const known = new Set(members.map(member => member.id));
  if (profile.compatibility.some(item => !known.has(item.member_id) || item.member_id === ownId)) {
    throw new CollaborationReferenceError('Nota de colaborare trebuie să se refere la un alt membru al acestui proiect.');
  }
}
