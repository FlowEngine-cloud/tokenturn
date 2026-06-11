/**
 * Minimal PDF writer for the scheduled monthly report (spec 11) - part of
 * ee/, commercial license (see ee/LICENSE).
 *
 * Zero dependencies: emits a plain PDF 1.4 document with the two standard
 * base-14 fonts the report needs (Helvetica for headings, Courier for the
 * table, whose fixed pitch makes column alignment exact). Output is
 * deterministic for a given input, so tests pin bytes.
 */

export interface PdfLine {
  text: string;
  /** H = Helvetica, B = Helvetica-Bold, C = Courier. */
  font?: "H" | "B" | "C";
  size?: number;
  /** Extra vertical gap (points) before this line. */
  gapBefore?: number;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const TOP_Y = PAGE_HEIGHT - 64;
const BOTTOM_Y = 56;

const FONT_RES: Record<NonNullable<PdfLine["font"]>, string> = {
  H: "/F1",
  B: "/F2",
  C: "/F3",
};

/** PDF string escape: backslash, parens; non-Latin-1 folds to '?'. */
function esc(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code >= 32 && code <= 255) out += ch;
    else out += "?";
  }
  return out;
}

function pageStream(lines: PdfLine[]): string {
  const ops: string[] = ["BT"];
  let y = TOP_Y;
  let first = true;
  for (const line of lines) {
    const size = line.size ?? 10;
    const leading = Math.round(size * 1.45);
    y -= (first ? 0 : leading) + (line.gapBefore ?? 0);
    first = false;
    ops.push(
      `${FONT_RES[line.font ?? "H"]} ${size} Tf`,
      `1 0 0 1 ${MARGIN_X} ${y} Tm`,
      `(${esc(line.text)}) Tj`,
    );
  }
  ops.push("ET");
  return ops.join("\n");
}

/** Split lines into pages by simulating the same cursor the stream uses. */
function paginate(lines: PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let y = TOP_Y;
  let first = true;
  for (const line of lines) {
    const size = line.size ?? 10;
    const leading = Math.round(size * 1.45);
    const next = y - ((first ? 0 : leading) + (line.gapBefore ?? 0));
    if (next < BOTTOM_Y && page.length > 0) {
      pages.push(page);
      page = [];
      y = TOP_Y;
      first = true;
      page.push({ ...line, gapBefore: 0 });
      continue;
    }
    page.push(line);
    y = next;
    first = false;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

/** Build the PDF file bytes. */
export function buildPdf(lines: PdfLine[]): Buffer {
  const pages = paginate(lines);

  // Object layout: 1 catalog, 2 pages tree, 3-5 fonts, then per page:
  // page object + content stream.
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  const firstPageObj = 6;
  pages.forEach((_, i) => pageObjNums.push(firstPageObj + i * 2));

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums
      .map((n) => `${n} 0 R`)
      .join(" ")}] /Count ${pages.length} >>\nendobj\n`,
  );
  objects.push(
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  objects.push(
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  objects.push(
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );

  pages.forEach((pageLines, i) => {
    const pageNum = firstPageObj + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> ` +
        `/Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = pageStream(pageLines);
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body +=
    xref +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
