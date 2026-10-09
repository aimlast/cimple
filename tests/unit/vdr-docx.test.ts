/**
 * vdr spec §9.5 step 5 (E15, U16): Word files in the data room. Runs the
 * REAL render child through the pool.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-docx.test.ts
 *
 * A docx built here with jszip holds: a javascript: hyperlink, a LINKED
 * picture pointing at a file on this disk (mammoth 1.8 would read it), an SVG
 * picture, ~7 MB of pictures (over the 5 MB budget), a SIN split across two
 * runs (bold + plain), and a SIN in the page header. Expect: no <a>, no
 * linked/SVG picture, pictures past the budget left out, the SIN covered,
 * the header's number counted for the original-download decision.
 * 046 454 286 is a Luhn-valid TEST number.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createRenderPool } from "../../server/vdr/render-pool";
import { coverHtmlBlocks, htmlToText } from "../../server/vdr/child/docx";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-docx-"));

// ── Pure: block covering ──
{
  const html = "<p><strong>SIN 046 454</strong> 286 for the owner</p><p>Revenue 29,180,000</p><table><tr><td>Employee</td><td>046-454-286</td></tr></table><ul><li><p>nested <em>SIN 046454286</em></p></li></ul>";
  const r = coverHtmlBlocks(html);
  assert.equal(r.count, 3);
  assert.ok(!/046/.test(r.html), r.html);
  assert.ok(r.html.includes("<p>SIN ••• ••• 286 for the owner</p>"), "the paragraph becomes its masked plain text");
  assert.ok(r.html.includes("<p>Revenue 29,180,000</p>"), "other blocks keep their formatting");
  assert.ok(r.html.includes("<td>•••-•••-286</td>"));
  assert.equal(htmlToText("<p>A &amp; B</p><table><tr><td>x</td><td>y</td></tr></table>"), "A & B\nx | y");
}

// ── Fixture ──
const secretPng = path.join(tmp, "server-secret.png");
const SECRET = Buffer.from("\x89PNG\r\n\x1a\nTHIS-IS-A-SERVER-FILE-THAT-MUST-NOT-BE-READ");
fs.writeFileSync(secretPng, SECRET);
const png = (size: number, seed: number) => {
  const b = Buffer.alloc(size, seed);
  Buffer.from("\x89PNG\r\n\x1a\n", "latin1").copy(b, 0);
  return b;
};
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const drawing = (attr: string, id: number) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="${id}" name="Picture ${id}" descr="picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${attr}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const zip = new JSZip();
zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file://${secretPng}" TargetMode="External"/>
<Relationship Id="rIdSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.svg"/>
<Relationship Id="rIdBig1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/big1.png"/>
<Relationship Id="rIdBig2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/big2.png"/>
<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`);
zip.file("word/media/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
zip.file("word/media/big1.png", png(3_500_000, 1));
zip.file("word/media/big2.png", png(3_500_000, 2));
zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${NS}><w:p><w:r><w:t>Employee 046-454-286</w:t></w:r></w:p></w:hdr>`);
zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>
<w:p><w:r><w:t>Employment agreement summary</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>SIN 046 454</w:t></w:r><w:r><w:t xml:space="preserve"> 286</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p>
<w:p>${drawing('r:link="rIdExt"', 1)}</w:p>
<w:p>${drawing('r:embed="rIdSvg"', 2)}</w:p>
<w:p>${drawing('r:embed="rIdBig1"', 3)}</w:p>
<w:p>${drawing('r:embed="rIdBig2"', 4)}</w:p>
<w:p><w:r><w:t>Salary 92,000</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/></w:sectPr>
</w:body></w:document>`);
const docxFile = path.join(tmp, "agreement.docx");
fs.writeFileSync(docxFile, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

const pool = createRenderPool({ maxChildren: 1 });
try {
  const out = path.join(tmp, "private-vdr-cache", "deal", "item", "eeeeeeeeeeeeeeee");
  const r = await pool.run({ kind: "prepare", file: docxFile, outDir: out, fileKind: "html", ext: ".docx" });
  assert.equal(r.kind, "html");
  const html = fs.readFileSync(path.join(out, "doc.html"), "utf8");
  assert.ok(!/<a\b/i.test(html), "no links");
  assert.ok(!/javascript:/i.test(html));
  assert.ok(html.includes("click me"), "the link's words stay");
  assert.ok(!html.includes(SECRET.toString("base64").slice(0, 24)), "the linked file on the server's disk was never read");
  assert.ok(!/image\/svg/i.test(html) && !/<svg/i.test(html), "no SVG");
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  assert.equal(imgs.length, 1, "one picture fits the 5 MB budget");
  assert.ok(imgs.every((t) => /src="data:image\/png;base64,/.test(t)));
  assert.ok((html.match(/\[picture left out\]/g) ?? []).length >= 2, "the SVG and the picture past the budget are left out");
  assert.ok(!/046/.test(html), "the split SIN is covered");
  assert.ok(html.includes("SIN ••• ••• 286"));
  assert.ok(!/style=|class=|on\w+=/i.test(html), "no styles, classes or handlers");
  assert.equal(r.personal.count, 1);
  assert.ok(r.officeScan!.parts.includes("word/header1.xml"), "the header's number blocks an original download");
  assert.ok(r.officeScan!.count >= 2);
  assert.match(r.pageTexts[0].text, /Employment agreement summary\nSIN ••• ••• 286\nclick me/);
  assert.ok(!r.pageTexts[0].text.includes("base64"), "page text has no picture data");
} finally {
  await pool.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("vdr docx: ok");
