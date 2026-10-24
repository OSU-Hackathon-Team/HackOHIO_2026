import { BuilderEditResponse, type BuilderEditRequest } from "@splice/contracts";
export async function requestBuilderEdit(request: BuilderEditRequest, signal?: AbortSignal) {
  const response = await fetch("/api/builder/edits", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal,
  });
  const body = await response.json().catch(() => ({ error: "The server returned an unreadable response" }));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Builder request failed (${response.status})`);
  const parsed = BuilderEditResponse.safeParse(body);
  if (!parsed.success) throw new Error("The assistant returned an invalid edit. Your layout was preserved. Try describing the change again.");
  return parsed.data;
}

export const requestBuilderEdits = requestBuilderEdit;
