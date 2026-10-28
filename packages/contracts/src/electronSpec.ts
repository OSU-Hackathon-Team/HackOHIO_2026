// Downstream reader for the frozen Electron behavioral handoff (`spec.json`).
// `scripts/electron/` remains the authority for this shape; this schema only lets intake verify a
// hash-pinned public artifact without importing the reconstruction pipeline. Analyst-only evidence,
// the original archive and the candidate project stay outside the handoff.
import { z } from "zod";

const prose = z.string().min(1);

export const ElectronContractChannel = z.object({
  /** Workspace-relative feature module the implementer must supply. */
  feature: prose,
  title: prose.optional(),
  description: prose.optional(),
  requirements: z.array(prose).min(1),
  params: z
    .array(z.object({ name: prose, type: z.enum(["string", "number", "boolean", "json"]).optional() }))
    .optional(),
});
export type ElectronContractChannel = z.infer<typeof ElectronContractChannel>;

export const ElectronChannelExclusion = z.object({ channel: prose, reason: prose });
export type ElectronChannelExclusion = z.infer<typeof ElectronChannelExclusion>;

export const ElectronContractApplication = z.object({
  name: prose,
  version: prose.optional(),
  scope: z.array(z.string()).min(1),
  exclusions: z.array(z.string()).optional(),
  /** Readiness blockers the specification stage declared; a blocked handoff is not implementable. */
  blockers: z.array(prose).optional(),
  unresolved: z.array(prose).optional(),
  environments: z.object({ clock: prose.optional() }).optional(),
});
export type ElectronContractApplication = z.infer<typeof ElectronContractApplication>;

export const ElectronContractSpec = z
  .object({
    schema_version: z.literal(2),
    application: ElectronContractApplication,
    channels: z.record(z.string().min(1), ElectronContractChannel),
    channel_exclusions: z.array(ElectronChannelExclusion).optional(),
  })
  .superRefine((spec, ctx) => {
    if (Object.keys(spec.channels).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The handoff declares no channels" });
    }
    const excluded = new Set<string>();
    for (const item of spec.channel_exclusions ?? []) {
      if (excluded.has(item.channel)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${item.channel}: excluded more than once` });
      }
      if (item.channel in spec.channels) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${item.channel}: is declared and excluded at the same time` });
      }
      excluded.add(item.channel);
    }
  });
export type ElectronContractSpec = z.infer<typeof ElectronContractSpec>;
