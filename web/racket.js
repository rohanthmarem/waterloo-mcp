const $ = (id) => document.getElementById(id);
let current = null,
  dirty = false,
  busy = false;
function message(text, error = false) {
  $("message").textContent = text;
  $("message").dataset.error = String(error);
}
function controls() {
  $("save").disabled = busy;
  $("run").disabled = busy || dirty || !current;
  $("revision").textContent = current
    ? `Revision ${current.revision}${dirty ? " · unsaved edits" : " · saved"}`
    : "New · not saved";
}
async function call(name, args) {
  const response = await fetch("/racket/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
    credentials: "same-origin",
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.code
        ? `${data.error.code}: ${data.error.action}`
        : "Request failed. Reopen the owner sign-in page if your session expired.",
    );
  return data;
}
async function refreshList() {
  const { workspaces } = await call("list_racket_workspaces", {});
  const selected = current?.id ?? $("workspaces").value;
  $("workspaces").replaceChildren(
    new Option("Choose a workspace", ""),
    ...workspaces.map((v) => new Option(v.title, v.id)),
  );
  $("workspaces").value = selected;
}
function show(value) {
  current = value;
  dirty = false;
  $("id").value = value.id;
  $("id").readOnly = true;
  $("title").value = value.title;
  $("language").value = value.language;
  $("code").value = value.code;
  $("assignment-title").value = value.assignment.title;
  $("assignment-url").value = value.assignment.url;
  $("assignment-text").value = value.assignment.text;
  $("source-link").hidden = !value.assignment.url;
  $("source-link").href = value.assignment.url || "#";
  const run = value.lastRun;
  $("run-status").textContent = run
    ? `Revision ${run.revision} · ${run.status}${run.code ? " · " + run.code : ""} · ${run.durationMs} ms`
    : "No run for this revision.";
  $("output").textContent = run
    ? run.stdout + (run.stderr ? "\n" + run.stderr : "")
    : "";
  controls();
}
async function action(fn) {
  if (busy) return;
  busy = true;
  controls();
  try {
    await fn();
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
    controls();
  }
}
$("save").onclick = () =>
  action(async () => {
    const value = await call("save_racket_workspace", {
      id: $("id").value,
      title: $("title").value,
      language: $("language").value,
      code: $("code").value,
      assignment: {
        title: $("assignment-title").value,
        text: $("assignment-text").value,
        url: $("assignment-url").value,
      },
      expectedRevision: current?.revision ?? 0,
    });
    show(value);
    await refreshList();
    message("Saved. You and your agent now see the same revision.");
  });
$("run").onclick = () =>
  action(async () => {
    message("Running saved code…");
    show(
      await call("run_racket_workspace", {
        id: current.id,
        expectedRevision: current.revision,
      }),
    );
    message("Run finished. Check the output for test failures.");
  });
$("load").onclick = () =>
  action(async () => {
    if (
      !$("workspaces").value ||
      (dirty && !confirm("Discard unsaved edits and load the saved workspace?"))
    )
      return;
    show(await call("read_racket_workspace", { id: $("workspaces").value }));
    message("Opened the saved revision.");
  });
$("new").onclick = () => {
  if (
    busy ||
    (dirty && !confirm("Discard unsaved edits and create a new workspace?"))
  )
    return;
  current = null;
  for (const id of [
    "id",
    "title",
    "assignment-title",
    "assignment-url",
    "assignment-text",
    "code",
  ])
    $(id).value = "";
  $("id").readOnly = false;
  $("source-link").hidden = true;
  $("output").textContent = "";
  $("run-status").textContent = "No run yet.";
  dirty = true;
  controls();
  message("Give this workspace a new ID and title.");
};
for (const id of [
  "id",
  "title",
  "language",
  "code",
  "assignment-title",
  "assignment-url",
  "assignment-text",
])
  $(id).addEventListener("input", () => {
    dirty = true;
    controls();
  });
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
setInterval(async () => {
  if (!current || busy) return;
  try {
    const value = await call("read_racket_workspace", { id: current.id });
    if (
      value.revision !== current.revision ||
      value.lastRun?.at !== current.lastRun?.at
    ) {
      if (dirty)
        message(
          "A newer saved revision is available. Your typing is preserved. Open the saved workspace when ready.",
          true,
        );
      else {
        show(value);
        message("Updated from the shared saved workspace.");
      }
    }
  } catch {}
}, 5000);
refreshList().catch((e) => message(e.message, true));
