// The preview of an e-mail template (OAD-015; routes.md §9, README §9, api-changes part 2 §2.6): the rendered subject,
// the HTML body in an `<iframe sandbox srcdoc>` and the text body, as `console.settings.templates.preview` answered
// them. No directive and no hooks: the editor (template-form.tsx, a client component) renders it, and a server
// component could too.
//
// The HTML is the OTA's own template rendered with sample data. It is never put into the admin's document: it goes only
// into the frame's `srcdoc`, and the frame's `sandbox` holds no permission at all (`sandbox=""`): no `allow-scripts`, so
// no script of the template runs, and no `allow-same-origin`, so the document gets an opaque origin and could reach
// neither the admin's cookies nor its storage even if it ran one; no forms, pop-ups or navigation of the admin either.
// The frame's document inherits the admin's Content Security Policy (README §10: `img-src 'self' data:`), so images on
// other hosts (the OTA's logo on the API host) are not shown in the preview, and the frame says so.
import type { RenderedPreview } from "../content-rules";

/**
 * The `sandbox` of the preview frame: no token. `allow-scripts` and `allow-same-origin` are what must never be in it
 * (together they would let the template's document lift its own sandbox); every other permission is left out as well.
 */
export const PREVIEW_SANDBOX = "";

export const PREVIEW_STRINGS = Object.freeze({
  heading: "Preview",
  intro:
    "Rendered with the template's sample data; nothing is saved or sent. Images on other hosts are not shown here.",
  subject: "Subject",
  html: "HTML body",
  frameTitle: "Preview of the HTML body of the e-mail",
  noHtml: "This template has no HTML body: the e-mail is sent as text only.",
  text: "Text body",
  emptyText: "(empty)",
});

/** The HTML body of a rendered e-mail in a sandboxed frame without scripts (`srcdoc`, never the admin's DOM). */
export function PreviewFrame({
  html,
  title = PREVIEW_STRINGS.frameTitle,
}: {
  readonly html: string;
  readonly title?: string;
}) {
  return (
    <iframe
      sandbox={PREVIEW_SANDBOX}
      srcDoc={html}
      title={title}
      referrerPolicy="no-referrer"
      className="h-[32rem] w-full rounded-md border bg-white"
    />
  );
}

/** A rendered e-mail: the subject, the HTML body in the frame (or why there is none) and the text body. */
export function TemplatePreview({ preview }: { readonly preview: RenderedPreview }) {
  return (
    <section aria-label={PREVIEW_STRINGS.heading} className="grid gap-4 rounded-md border p-4">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">{PREVIEW_STRINGS.heading}</h2>
        <p className="text-sm text-muted-foreground">{PREVIEW_STRINGS.intro}</p>
      </div>
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">{PREVIEW_STRINGS.subject}</h3>
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-preview="subject">
          {preview.subject}
        </p>
      </div>
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">{PREVIEW_STRINGS.html}</h3>
        {preview.html === null ? (
          <p className="text-sm text-muted-foreground">{PREVIEW_STRINGS.noHtml}</p>
        ) : (
          <PreviewFrame html={preview.html} />
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">{PREVIEW_STRINGS.text}</h3>
        <pre
          className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap"
          data-preview="text"
        >
          {preview.text === "" ? PREVIEW_STRINGS.emptyText : preview.text}
        </pre>
      </div>
    </section>
  );
}
