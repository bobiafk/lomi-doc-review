"use client";

import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "./api";
import { isInFlight, listRefetchInterval, POLL_MS } from "./review";

/**
 * Polling, not streaming: extraction takes seconds and only changes a status,
 * so the list refetches every 2s while something is queued/extracting and
 * stops completely once everything has settled.
 */
export function useDocuments() {
  return useQuery({
    queryKey: queryKeys.documents,
    queryFn: api.listDocuments,
    refetchInterval: (query) => listRefetchInterval(query.state.data?.documents),
  });
}

export function useDocument(id: string, versionNo?: number) {
  return useQuery({
    queryKey: queryKeys.document(id, versionNo),
    queryFn: () => api.getDocument(id, versionNo),
    refetchInterval: (query) => (query.state.data && isInFlight(query.state.data.version.status) ? POLL_MS : false),
  });
}
