import { z } from "zod";

const prose = z.string().min(1);

// Implementer-facing artifact. Citations and reviews stay in a separate audit artifact.
export const NativeSubsystemSpec = z.object({
  schema: z.literal(2),
  kind: z.literal("native_subsystem_spec"),
  status: z.literal("ready_for_review"),
  title: prose,
  purpose: prose,
  boundary: z.enum(["subsystem", "project"]),
  interface: z.object({
    inputs: z.array(prose).min(1),
    outputs: z.array(prose).min(1),
    state: z.array(prose),
  }),
  requirements: z.array(z.object({
    id: z.string().regex(/^REQ-\d+$/),
    statement: prose,
  })).min(1),
  behavior_steps: z.array(prose).min(1),
  examples: z.array(z.object({
    name: prose,
    input: z.unknown(),
    expected_output: z.unknown(),
  })).min(1),
  acceptance_criteria: z.array(prose).min(1),
  deviations: z.array(prose),
  exclusions: z.array(prose),
});
export type NativeSubsystemSpec = z.infer<typeof NativeSubsystemSpec>;
