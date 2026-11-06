import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const META_CHANGED = "project-meta";

const metaSchema = z.object({
  focus: z.string().nullable(),
  focusUpdatedAt: z.string().nullable(),
  leadThreadId: z.string().nullable(),
});
export type ProjectMeta = z.infer<typeof metaSchema>;

const projectIdSchema = z.string().trim().min(1).max(100);

export const projectsContract = defineRpcContract({
  getMeta: {
    tags: (input: { projectId: string }) => [`meta:${input.projectId}`],
    input: z.object({ projectId: projectIdSchema }),
    output: metaSchema,
  },
  setFocus: {
    input: z.object({ projectId: projectIdSchema, focus: z.string().max(600).nullable() }),
    output: metaSchema,
  },
  listLeads: {
    tags: () => ["leads"],
    input: z.object({}),
    output: z.object({ leads: z.array(z.object({ projectId: z.string(), threadId: z.string() })) }),
  },
  setLead: {
    input: z.object({ projectId: projectIdSchema, threadId: z.string().startsWith("thr_").nullable() }),
    output: metaSchema,
  },
});
