import { DOCUMENT_TYPES } from "@lomi/shared";

export default function HomePage() {
  return (
    <main>
      <h1>Lomi document review</h1>
      <p>Supported document types: {DOCUMENT_TYPES.join(", ")}</p>
    </main>
  );
}
