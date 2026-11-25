export function createDescriptionAutosave({ save, onChange, canSave = () => true }) {
  let draft = null;
  let status = "";
  let timer = null;
  let request = null;
  let composing = false;

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (request) return request;
    if (!draft || composing) return Promise.resolve();
    if (!canSave()) {
      schedule(100);
      return Promise.resolve();
    }

    const snapshot = draft;
    status = "Saving…";
    request = Promise.resolve().then(async () => {
      let failed = false;
      try {
        await save(snapshot);
        if (draft?.id === snapshot.id && draft.value === snapshot.value) draft = null;
        status = draft ? "Saving…" : "Saved";
      } catch {
        failed = true;
        status = "Couldn’t save. Retrying…";
      } finally {
        request = null;
        onChange();
        if (draft && timer === null && !composing) schedule(failed ? 2000 : 0);
      }
    });
    onChange();
    return request;
  }

  return {
    get draft() { return draft; },
    get status() { return status; },
    get saving() { return request !== null; },
    update(id, value, isComposing = false) {
      draft = { id, value };
      composing = isComposing;
      status = "Saving…";
      clearTimeout(timer);
      timer = null;
      if (!composing) schedule(500);
      onChange();
    },
    pause() {
      composing = true;
      clearTimeout(timer);
      timer = null;
    },
    discard(id) {
      if (draft?.id !== id) return;
      draft = null;
      status = "";
      clearTimeout(timer);
      timer = null;
      onChange();
    },
    flush,
  };
}
