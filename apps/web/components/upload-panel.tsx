"use client";

import { DOCUMENT_TYPES, type DocumentType } from "@lomi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, queryKeys } from "../lib/api";
import { humanizeType } from "../lib/format";

/** New document: type + PDF (+ optional title). Returns as soon as the API has queued it. */
export function UploadPanel({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [type, setType] = useState<DocumentType>("invoice");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: () => api.uploadDocument({ type, ...(title.trim() && { title: title.trim() }), file: file! }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents });
      onDone();
      router.push(`/documents/${encodeURIComponent(res.document.id)}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (file) upload.mutate();
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="form-row">
        <label className="field">
          Type
          <select className="select" value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanizeType(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: 180 }}>
          Title (optional)
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" />
        </label>
        <label className="field">
          PDF
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn primary" type="submit" disabled={!file || upload.isPending}>
          {upload.isPending ? "Uploading…" : "Upload"}
        </button>
        <button className="btn ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {upload.error && <p className="error-text">{upload.error.message}</p>}
    </form>
  );
}
