import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it.each([
    "<html><head data-condition='x > 0'>",
    '<html><head data-condition="x > 0" data-label=\'it "works"\'>',
    "<html data-condition='x > 0'>",
    '<html data-condition="x > 0" data-label="it \'works\'">',
  ])("keeps the bootstrap after the complete opening tag: %s", (opening) => {
    const prefix = `<!doctype html>${opening}`;
    const head = opening.startsWith("<html><head") ? "" : "<head>";
    const content = `${head ? "" : "<title>Report</title></head>"}<body><p>Report</p></body></html>`;
    const injected = injectHtmlRenderBootstrap(prefix + content);
    expect(injected.startsWith(`${prefix}${head}<meta charset="utf-8">`)).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(prefix.length);
    expect(injected).toContain("<script>");
    expect(injected.endsWith(content)).toBe(true);
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("bounds the bootstrap's gallery before posting it and keeps the clicked image selected", () => {
    const image = (src: string) => ({ src, tagName: "IMG", closest: () => null });
    const clicked = image("https://example.com/clicked.png");
    const large = image(`data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`);
    const document = {
      images: [large, large, large, clicked],
      getElementById: () => ({ textContent: "" }),
      addEventListener: () => {},
    };
    let click: (event: object) => void = () => {};
    let posted = { params: { images: [] as Array<{ src: string; name: string }>, index: -1 } };
    const window = {
      parent: {
        postMessage: (message: typeof posted) => {
          posted = message;
        },
      },
      addEventListener: (name: string, handler: typeof click) => {
        if (name === "click") click = handler;
      },
    };
    const script = injectHtmlRenderBootstrap("<p>Report</p>").match(
      /<script>([\s\S]*?)<\/script>/,
    )?.[1];
    if (script === undefined) throw new Error("Missing HTML bootstrap");
    NodeVM.runInNewContext(script, {
      window,
      document,
      location: { hash: "" },
      setTimeout: (run: () => void) => run(),
    });
    const event = { composedPath: () => [clicked], isTrusted: true, button: 0 };
    click(event);
    expect(
      posted.params.images.reduce(
        (size, entry) => size + entry.src.length + entry.name.length,
        clicked.src.length,
      ),
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(posted.params.images[posted.params.index]?.src).toBe(clicked.src);
    document.images = [
      ...Array.from({ length: 1000 }, () => image("https://example.com/other.png")),
      clicked,
    ];
    click(event);
    expect(posted.params.images.length).toBeLessThanOrEqual(64);
    expect(posted.params.images[posted.params.index]?.src).toBe(clicked.src);
  });

  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({ images: [{ src: "data:image/png;base64,AA", name: "Chart" }], index: 0 });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      images: [{ src: "https://example.com/a.png", name: "Image" }],
      index: 0,
    });
    const boundaryImage = readHtmlRenderImageRequest(
      image({ src: "https://example.com/a.png", name: "a".repeat(199) + "😀" }),
    );
    expect(boundaryImage?.images[0]?.name.isWellFormed()).toBe(true);
    expect(boundaryImage?.images[0]?.name).toBe("a".repeat(199));
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });

  it("keeps the page's other images, dropping unsafe ones, around the clicked image", () => {
    const b = { src: "https://example.com/b.png", name: "B" };
    const params = {
      ...b,
      images: [{ src: "https://example.com/a.png", name: "A" }, { src: "blob:null/1" }, b, null],
      index: 2,
    };
    const request = (overrides: object) =>
      readHtmlRenderImageRequest({
        jsonrpc: "2.0",
        method: "t3/notifications/open-image",
        params: { ...params, ...overrides },
      });
    expect(request({})).toEqual({
      images: [{ src: "https://example.com/a.png", name: "A" }, b],
      index: 1,
    });
    // An index that does not point at the clicked image falls back to that image alone.
    expect(request({ index: 0 })).toEqual({ images: [b], index: 0 });
    expect(request({ index: -1 })).toEqual({ images: [b], index: 0 });
    const largeImage = { src: `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}` };
    expect(
      request({ images: [largeImage, largeImage, largeImage, b], index: 3 })?.images,
    ).toHaveLength(1);
    expect(request({ images: Array.from({ length: 1000 }, () => b), index: 999 })).toEqual({
      images: [b],
      index: 0,
    });
    expect(
      request({ src: `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}` }) === undefined,
    ).toBe(true);
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});
