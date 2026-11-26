"use client";

import type { ValueDto, VersionDetail } from "@lomi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { api, queryKeys } from "../lib/api";
import { humanizeType, relativeTime } from "../lib/format";
import { useDocument } from "../lib/hooks";
import { attentionSummary, groupValues, isInFlight, needsAttention } from "../lib/review";
import { DocumentText } from "./document-text";
import { ProgressBar } from "./progress-bar";
import { StatusTag, TYPE_ICON } from "./tags";
import { ValueRow } from "./value-row";

export function DocumentView({ id, versionNo }: { id: string; versionNo?: number }) {
  const { data, error, isPending } = useDocument(id, versionNo);

  if (isPending) {
    return (
      <div className="page narrow">
        <div className="skeleton" style={{ width: "40%", height: 36 }} />
        <div className="skeleton" style={{ width: "70%" }} />
        <div className="skeleton" style={{ width: "60%" }} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page narrow">
        <div className="callout red">
          <span className="callout-icon">⚠️</span>
          <div className="callout-body">
            <div className="callout-title">Couldn't load this document</div>
            {error.message} · <Link href="/">Back to documents</Link>
          </div>
        </div>
      </div>
    );
  }
  return <Loaded detail={data} />;
}

function Loaded({ detail }: { detail: VersionDetail }) {
  const { document, version, values, progress } = detail;
  const groups = groupValues(values);
  const [focusedId, setFocusedId] = useState<string | null>(groups.attention[0]?.id ?? values[0]?.id ?? null);
  const focused = values.find((v) => v.id === focusedId) ?? null;
  const editable = version.isCurrent && version.status === "extracted";
  const previousVersion = document.versions.filter((v) => v.versionNo < version.versionNo && v.status === "extracted").at(-1);

  const row = (value: ValueDto) => (
    <ValueRow
      key={value.id}
      value={value}
      documentId={document.id}
      editable={editable}
      focused={value.id === focusedId}
      onFocus={() => setFocusedId(value.id)}
    />
  );

  return (
    <>
      <div className="topbar">
        <Link href="/">Documents</Link>
        <span className="faint">/</span>
        <span>{document.title}</span>
      </div>
      <div className="page">
        <div className="page-icon">{TYPE_ICON[document.type]}</div>
        <h1 className="page-title">{document.title}</h1>

        <div className="properties">
          <div className="prop-name">Type</div>
          <div className="prop-value">{humanizeType(document.type)}</div>
          <div className="prop-name">Status</div>
          <div className="prop-value">
            <StatusTag status={version.status} />
            {version.attempt > 1 && <span className="faint">attempt {version.attempt}</span>}
          </div>
          <div className="prop-name">Version</div>
          <div className="prop-value">
            <VersionSwitcher detail={detail} />
            <span className="faint">
              {version.fileName} · {relativeTime(version.createdAt)}
            </span>
            {version.isCurrent && <NewVersionButton documentId={document.id} />}
          </div>
          <div className="prop-name">Review</div>
          <div className="prop-value" style={{ minWidth: 220 }}>
            <ProgressBar progress={progress} />
          </div>
        </div>
        <hr className="divider" />

        <StatusCallout detail={detail} previousVersionNo={previousVersion?.versionNo} />

        {values.length > 0 && (
          <>
            <p className="summary-line">
              {needsAttention(progress) > 0 ? "🟠" : "✅"} <strong>{attentionSummary(progress, version.status)}</strong>
            </p>
            <div className="doc-layout">
              <div>
                <Group title="Needs your review" count={groups.attention.length} hint={editable ? "Changed values first, then pending values, then gaps." : undefined} empty="Nothing left to review.">
                  {groups.attention.map(row)}
                </Group>
                {groups.carriedOver.length > 0 && (
                  <Group title="Carried over" count={groups.carriedOver.length} hint="Same value, same quote as the previous version: its review was kept.">
                    {groups.carriedOver.map(row)}
                  </Group>
                )}
                <Group title="Reviewed" count={groups.reviewed.length} empty="Nothing reviewed yet." collapsible>
                  {groups.reviewed.map(row)}
                </Group>
              </div>
              {version.parsedText && (
                <DocumentText text={version.parsedText} value={focused} versionNo={version.versionNo} />
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Group({
  title,
  count,
  hint,
  empty,
  collapsible,
  children,
}: {
  title: string;
  count: number;
  hint?: string | undefined;
  empty?: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="group">
      <button className="group-header" onClick={() => collapsible && setOpen((o) => !o)} aria-expanded={open} disabled={!collapsible}>
        <span className={`chevron ${open ? "open" : ""}`}>{collapsible ? "▶" : ""}</span>
        {title} <span className="count">{count}</span>
      </button>
      {open && hint && count > 0 && <p className="group-hint">{hint}</p>}
      {open && (count > 0 ? children : empty && <div className="group-empty">{empty}</div>)}
    </section>
  );
}

function StatusCallout({ detail, previousVersionNo }: { detail: VersionDetail; previousVersionNo: number | undefined }) {
  const { document, version } = detail;
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retry(document.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["document", document.id] }),
  });
  const linkToPrevious = previousVersionNo !== undefined && (
    <Link className="btn small" href={`/documents/${encodeURIComponent(document.id)}?v=${previousVersionNo}`}>
      View v{previousVersionNo} values
    </Link>
  );

  if (!version.isCurrent) {
    return (
      <div className="callout yellow">
        <span className="callout-icon">🕰️</span>
        <div className="callout-body">
          <div className="callout-title">You're looking at v{version.versionNo} ({version.status}). It's read-only.</div>
          The current version is v{document.currentVersion.versionNo}.
          <div className="callout-actions">
            <Link className="btn small" href={`/documents/${encodeURIComponent(document.id)}`}>
              Go to current version
            </Link>
          </div>
        </div>
      </div>
    );
  }
  if (isInFlight(version.status)) {
    return (
      <div className="callout blue">
        <span className="callout-icon">⏳</span>
        <div className="callout-body">
          <div className="callout-title">
            {version.status === "queued" ? "Waiting for a worker" : "Extracting values"} for v{version.versionNo}…
          </div>
          This page updates by itself. Values and their quotes will appear here when extraction finishes.
          {previousVersionNo !== undefined && <> Reviews whose quotes didn't change will carry over from v{previousVersionNo}.</>}
          {linkToPrevious && <div className="callout-actions">{linkToPrevious}</div>}
        </div>
      </div>
    );
  }
  if (version.status === "failed") {
    return (
      <div className="callout red">
        <span className="callout-icon">⚠️</span>
        <div className="callout-body">
          <div className="callout-title">Extraction failed for v{version.versionNo}</div>
          <div className="mono" style={{ wordBreak: "break-word" }}>{version.lastError ?? "Unknown error"}</div>
          <div className="callout-actions">
            <button className="btn primary small" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? "Retrying…" : "Retry extraction"}
            </button>
            {linkToPrevious}
          </div>
          {retry.error && <p className="error-text">{retry.error.message}</p>}
        </div>
      </div>
    );
  }
  return null;
}

function VersionSwitcher({ detail }: { detail: VersionDetail }) {
  const router = useRouter();
  const { document, version } = detail;
  if (document.versions.length === 1) return <span>v{version.versionNo}</span>;
  return (
    <select
      className="select"
      value={version.versionNo}
      aria-label="Version"
      onChange={(e) => {
        const n = Number(e.target.value);
        const base = `/documents/${encodeURIComponent(document.id)}`;
        router.push(n === document.currentVersion.versionNo ? base : `${base}?v=${n}`);
      }}
    >
      {[...document.versions].reverse().map((v) => (
        <option key={v.versionNo} value={v.versionNo}>
          v{v.versionNo} · {v.status}
          {v.versionNo === document.currentVersion.versionNo ? " (current)" : ""}
        </option>
      ))}
    </select>
  );
}

function NewVersionButton({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadVersion(documentId, file),
    onSuccess: async (res) => {
      setNotice(res.duplicate ? "Same file as the current version: nothing new to extract." : null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["document", documentId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.documents }),
      ]);
    },
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = "";
        }}
      />
      <button className="btn small" onClick={() => input.current?.click()} disabled={upload.isPending}>
        {upload.isPending ? "Uploading…" : "⬆ Upload new version"}
      </button>
      {notice && <span className="faint">{notice}</span>}
      {upload.error && <span className="error-text">{upload.error.message}</span>}
    </>
  );
}
