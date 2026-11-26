"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { relativeTime } from "../lib/format";
import { useDocuments } from "../lib/hooks";
import { needsAttention } from "../lib/review";
import { ProgressBar } from "./progress-bar";
import { StatusTag, TYPE_ICON, TypeTag } from "./tags";
import { UploadPanel } from "./upload-panel";

/** Notion-style database view of every document. */
export function DocumentList() {
  const router = useRouter();
  const { data, error, isPending } = useDocuments();
  const [uploading, setUploading] = useState(false);
  const documents = data?.documents ?? [];
  const waiting = documents.reduce((sum, d) => sum + (d.status === "extracted" ? needsAttention(d.progress) : 0), 0);

  return (
    <div className="page">
      <div className="page-icon">🗂️</div>
      <h1 className="page-title">Documents</h1>
      <p className="page-subtitle">
        {isPending
          ? "Loading…"
          : waiting > 0
            ? `${waiting} value${waiting === 1 ? "" : "s"} waiting for review across ${documents.length} documents.`
            : `${documents.length} documents. Nothing waiting for review.`}
      </p>

      <div className="db-toolbar">
        <span className="db-view">▦ Table</span>
        <button className="btn primary small" onClick={() => setUploading((u) => !u)}>
          New
        </button>
      </div>
      {uploading && <UploadPanel onDone={() => setUploading(false)} />}

      {error && <div className="callout red"><span className="callout-icon">⚠️</span><div className="callout-body">{error.message}</div></div>}

      <table className="db-table">
        <thead>
          <tr>
            <th>Aa Title</th>
            <th>Type</th>
            <th>Status</th>
            <th>Version</th>
            <th>Review progress</th>
            <th>Needs you</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => {
            const todo = needsAttention(doc.progress);
            return (
              <tr key={doc.id} onClick={() => router.push(`/documents/${encodeURIComponent(doc.id)}`)}>
                <td>
                  <span className="db-title">
                    <span className="icon">{TYPE_ICON[doc.type]}</span>
                    {doc.title}
                  </span>
                </td>
                <td><TypeTag type={doc.type} /></td>
                <td><StatusTag status={doc.status} /></td>
                <td className="muted">
                  v{doc.currentVersion.versionNo}
                  <span className="faint"> · {relativeTime(doc.currentVersion.createdAt)}</span>
                </td>
                <td><ProgressBar progress={doc.progress} /></td>
                <td>{doc.status === "extracted" && todo > 0 ? <span className="attention-count">{todo} to review</span> : <span className="faint">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!isPending && documents.length === 0 && <div className="db-empty">No documents yet. Click New to upload a PDF.</div>}
    </div>
  );
}
