import { DocumentView } from "../../../components/document-view";

export default async function DocumentPage(props: PageProps<"/documents/[id]">) {
  const { id } = await props.params;
  const { v } = await props.searchParams;
  const versionNo = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
  return <DocumentView key={`${id}:${versionNo ?? "current"}`} id={id} versionNo={versionNo} />;
}
