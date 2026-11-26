"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDocuments } from "../lib/hooks";
import { isInFlight, needsAttention } from "../lib/review";
import { TYPE_ICON } from "./tags";

/** Notion-style page tree: every document, with a dot when it wants something from you. */
export function Sidebar() {
  const pathname = usePathname();
  const { data } = useDocuments();
  const documents = data?.documents ?? [];

  return (
    <nav className="sidebar" aria-label="Documents">
      <div className="sidebar-workspace">
        <span className="sidebar-logo">L</span>
        Lomi Review
      </div>
      <Link href="/" className={`sidebar-item ${pathname === "/" ? "active" : ""}`}>
        <span>🗂️</span>
        <span className="label">All documents</span>
      </Link>
      <div className="sidebar-section">Documents</div>
      {documents.map((doc) => {
        const href = `/documents/${encodeURIComponent(doc.id)}`;
        const dot = isInFlight(doc.status)
          ? "busy"
          : doc.status === "failed"
            ? "failed"
            : needsAttention(doc.progress) > 0
              ? "attention"
              : null;
        return (
          <Link key={doc.id} href={href} className={`sidebar-item ${pathname === href ? "active" : ""}`}>
            <span>{TYPE_ICON[doc.type]}</span>
            <span className="label">{doc.title}</span>
            {dot && <span className={`dot ${dot}`} aria-label={dot} />}
          </Link>
        );
      })}
    </nav>
  );
}
