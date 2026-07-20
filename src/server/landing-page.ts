const REPOSITORY_URL = "https://github.com/naeemdadi/impact-analysis";
const README_URL = `${REPOSITORY_URL}#readme`;
const ARCHITECTURE_URL = `${REPOSITORY_URL}/blob/main/docs/ARCHITECTURE.md`;

/**
 * A public, static product page. It deliberately contains no operational state:
 * webhook delivery and database health are available from /health and logs, not
 * from a marketing page that could become misleading during an outage.
 */
export function renderLandingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Evidence-backed pull request verification guidance for GitHub." />
    <meta name="theme-color" content="#080b13" />
    <title>PR Impact Analysis — Know what to verify before merging</title>
    <style>
      :root {
        color-scheme: dark;
        --canvas: #080b13;
        --surface: #0d1220;
        --surface-raised: #131a2b;
        --line: rgba(180, 198, 255, .14);
        --text: #f4f6fc;
        --muted: #aab4cc;
        --subtle: #737f9d;
        --violet: #9c8cff;
        --blue: #73b6ff;
        --mint: #75e3c0;
        --coral: #fa8e95;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        min-width: 320px;
        margin: 0;
        color: var(--text);
        background:
          radial-gradient(65rem 44rem at 83% -6%, rgba(87, 73, 211, .25), transparent 62%),
          radial-gradient(45rem 34rem at -12% 31%, rgba(30, 132, 190, .15), transparent 61%),
          var(--canvas);
      }
      a { color: inherit; }
      a:focus-visible { outline: 3px solid var(--mint); outline-offset: 4px; border-radius: .35rem; }
      .shell { width: min(1180px, calc(100% - 2.5rem)); margin: 0 auto; }
      .topline {
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: .79rem;
        letter-spacing: .02em;
      }
      .topline .shell { display: flex; justify-content: center; padding: .65rem 0; }
      header { position: sticky; z-index: 5; top: 0; backdrop-filter: blur(16px); background: rgba(8, 11, 19, .74); border-bottom: 1px solid rgba(180, 198, 255, .08); }
      nav { display: flex; align-items: center; justify-content: space-between; min-height: 4.75rem; gap: 1rem; }
      .brand { display: inline-flex; align-items: center; gap: .68rem; text-decoration: none; font-weight: 760; letter-spacing: -.025em; }
      .brand-mark { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border: 1px solid rgba(156, 140, 255, .55); border-radius: .58rem; color: #d9d2ff; background: linear-gradient(145deg, rgba(156, 140, 255, .32), rgba(54, 120, 242, .12)); box-shadow: inset 0 1px rgba(255,255,255,.13); }
      .brand-mark svg { width: 1.1rem; height: 1.1rem; }
      .nav-links { display: flex; align-items: center; gap: 1.3rem; color: var(--muted); font-size: .91rem; }
      .nav-links a { text-decoration: none; }
      .nav-links a:hover { color: var(--text); }
      .nav-github { padding: .58rem .8rem; border: 1px solid var(--line); border-radius: .55rem; color: var(--text) !important; }

      .hero { display: grid; grid-template-columns: minmax(0, .92fr) minmax(400px, 1.08fr); align-items: center; gap: 4.5rem; padding: 7rem 0 5rem; }
      .eyebrow { display: flex; align-items: center; gap: .5rem; margin: 0 0 1.3rem; color: #c8c2ff; font-size: .76rem; font-weight: 760; letter-spacing: .12em; text-transform: uppercase; }
      .eyebrow::before { content: ""; width: .48rem; height: .48rem; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 .28rem rgba(117, 227, 192, .12); }
      h1, h2, h3, p { margin-top: 0; }
      h1 { max-width: 10ch; margin-bottom: 1.45rem; font-size: clamp(3.15rem, 6.3vw, 5.8rem); line-height: .96; letter-spacing: -.073em; }
      .gradient-text { background: linear-gradient(110deg, #fff 16%, #c6c0ff 50%, #83c6ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .lede { max-width: 37rem; margin-bottom: 2rem; color: var(--muted); font-size: clamp(1.06rem, 1.55vw, 1.22rem); line-height: 1.72; }
      .hero-actions { display: flex; flex-wrap: wrap; gap: .8rem; }
      .button { display: inline-flex; align-items: center; justify-content: center; gap: .5rem; min-height: 3rem; padding: .75rem 1rem; border: 1px solid transparent; border-radius: .65rem; text-decoration: none; font-weight: 730; font-size: .94rem; transition: transform .18s ease, border-color .18s ease, background .18s ease; }
      .button:hover { transform: translateY(-2px); }
      .button-primary { color: #090b15; background: linear-gradient(115deg, #b8abff, #83c7ff); box-shadow: 0 11px 26px rgba(105, 123, 255, .22); }
      .button-secondary { border-color: var(--line); background: rgba(255,255,255,.035); color: var(--text); }
      .button svg { width: 1rem; height: 1rem; }
      .proof { display: flex; align-items: center; gap: .65rem; margin: 1.7rem 0 0; color: var(--subtle); font-size: .84rem; }
      .proof span { display: inline-flex; align-items: center; gap: .42rem; }
      .proof span + span::before { content: ""; width: 1px; height: 1rem; margin-right: .65rem; background: var(--line); }
      .check { color: var(--mint); font-weight: 800; }

      .report-window { position: relative; isolation: isolate; overflow: hidden; border: 1px solid rgba(159, 178, 246, .23); border-radius: 1rem; background: #f6f8fc; box-shadow: 0 2rem 5rem rgba(0, 0, 0, .42), 0 0 0 1px rgba(255,255,255,.03) inset; transform: perspective(1500px) rotateY(-3deg) rotateX(1deg); }
      .report-window::after { content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none; background: linear-gradient(180deg, transparent 60%, rgba(9, 12, 22, .26)); }
      .window-bar { position: absolute; z-index: 3; inset: 0 0 auto; display: flex; align-items: center; justify-content: space-between; height: 2.65rem; padding: 0 .85rem; color: #4b5569; background: rgba(255,255,255,.93); border-bottom: 1px solid #d8dfeb; font: 650 .69rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .window-dots { display: flex; gap: .35rem; }
      .window-dots i { width: .52rem; height: .52rem; border-radius: 50%; background: #d7deeb; }
      .window-pill { padding: .28rem .5rem; border-radius: .27rem; color: #3266a3; background: #eef5ff; }
      .report-window img { display: block; width: 100%; min-height: 42rem; padding-top: 2.65rem; object-fit: cover; object-position: top; filter: saturate(.97); }
      .report-label { position: absolute; z-index: 4; right: 1rem; bottom: 1rem; padding: .53rem .68rem; border: 1px solid rgba(255,255,255,.4); border-radius: .5rem; color: white; background: rgba(8, 11, 19, .77); font-size: .73rem; font-weight: 700; backdrop-filter: blur(8px); }

      .trust-strip { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0 0 8rem; border: 1px solid var(--line); border-radius: .95rem; background: rgba(13, 18, 32, .65); }
      .trust-strip div { padding: 1.15rem 1.25rem; }
      .trust-strip div + div { border-left: 1px solid var(--line); }
      .trust-strip strong { display: block; margin-bottom: .3rem; font-size: .92rem; }
      .trust-strip span { color: var(--muted); font-size: .85rem; line-height: 1.45; }

      section { scroll-margin-top: 6rem; }
      .section-intro { max-width: 44rem; margin-bottom: 2.6rem; }
      .section-tag { margin-bottom: .72rem; color: var(--blue); font-size: .78rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
      h2 { margin-bottom: .9rem; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.02; letter-spacing: -.055em; }
      .section-intro p { margin-bottom: 0; color: var(--muted); font-size: 1.05rem; line-height: 1.7; }
      .steps { display: grid; grid-template-columns: repeat(5, 1fr); gap: .65rem; }
      .step { position: relative; min-height: 13.5rem; padding: 1.25rem; border: 1px solid var(--line); border-radius: .85rem; background: linear-gradient(145deg, rgba(22, 29, 48, .85), rgba(12, 17, 30, .66)); }
      .step:not(:last-child)::after { content: "→"; position: absolute; z-index: 1; top: 50%; right: -.5rem; display: grid; place-items: center; width: 1rem; height: 1rem; transform: translateY(-50%); color: var(--blue); font-size: .82rem; background: var(--canvas); }
      .step-number { color: var(--violet); font: 700 .75rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .step h3 { margin: 2.3rem 0 .55rem; font-size: 1rem; letter-spacing: -.02em; }
      .step p { margin: 0; color: var(--muted); font-size: .86rem; line-height: 1.55; }

      .principles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; padding: 8rem 0; }
      .principle { min-height: 18rem; padding: 1.6rem; border: 1px solid var(--line); border-radius: 1rem; background: rgba(13, 18, 32, .74); }
      .icon-box { display: grid; place-items: center; width: 2.7rem; height: 2.7rem; margin-bottom: 2.2rem; border-radius: .7rem; color: var(--mint); background: rgba(117, 227, 192, .1); border: 1px solid rgba(117, 227, 192, .16); }
      .icon-box.violet { color: #b6aaff; background: rgba(156, 140, 255, .11); border-color: rgba(156, 140, 255, .17); }
      .icon-box.blue { color: var(--blue); background: rgba(115, 182, 255, .1); border-color: rgba(115, 182, 255, .17); }
      .icon-box svg { width: 1.25rem; height: 1.25rem; }
      .principle h3 { margin-bottom: .6rem; font-size: 1.14rem; letter-spacing: -.025em; }
      .principle p { margin: 0; color: var(--muted); line-height: 1.65; }

      .reports { padding: 1rem 0 8rem; }
      .report-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.2rem; }
      .report-card { overflow: hidden; border: 1px solid var(--line); border-radius: 1rem; background: var(--surface); text-decoration: none; transition: transform .18s ease, border-color .18s ease; }
      .report-card:hover { transform: translateY(-4px); border-color: rgba(156, 140, 255, .55); }
      .report-card .preview { overflow: hidden; height: 22rem; background: #f6f8fc; }
      .report-card img { display: block; width: 100%; min-height: 100%; object-fit: cover; object-position: top; transition: transform .3s ease; }
      .report-card:hover img { transform: scale(1.025); }
      .report-card-copy { padding: 1.2rem 1.25rem 1.3rem; }
      .report-card-copy small { color: var(--mint); font-size: .72rem; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
      .report-card-copy h3 { margin: .55rem 0 .45rem; font-size: 1.08rem; }
      .report-card-copy p { margin: 0; color: var(--muted); font-size: .9rem; line-height: 1.55; }

      .demo { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2rem; align-items: center; margin-bottom: 7rem; padding: clamp(2rem, 5vw, 4rem); overflow: hidden; border: 1px solid rgba(156, 140, 255, .32); border-radius: 1.2rem; background: linear-gradient(120deg, rgba(55, 48, 126, .5), rgba(18, 34, 63, .55)); }
      .demo h2 { max-width: 16ch; }
      .demo p { max-width: 39rem; margin-bottom: 0; color: #c8d1e7; line-height: 1.7; }
      .demo-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.75rem; }
      .demo-badge { display: grid; place-items: center; width: 9.5rem; height: 9.5rem; border: 1px solid rgba(214, 225, 255, .2); border-radius: 50%; color: #eef1ff; background: rgba(8, 11, 19, .25); text-align: center; font-size: .85rem; font-weight: 720; line-height: 1.25; transform: rotate(8deg); }
      .demo-badge em { display: block; color: var(--mint); font-size: .68rem; font-style: normal; letter-spacing: .08em; text-transform: uppercase; }

      footer { padding: 2.3rem 0 3rem; border-top: 1px solid var(--line); }
      .footer-row { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; color: var(--subtle); font-size: .83rem; }
      .footer-links { display: flex; gap: 1rem; }
      .footer-links a { color: var(--muted); }
      .footer-links a:hover { color: var(--text); }

      @media (max-width: 900px) {
        .hero { grid-template-columns: 1fr; gap: 3rem; padding-top: 5rem; }
        h1 { max-width: 12ch; }
        .report-window { max-width: 42rem; transform: none; }
        .steps { grid-template-columns: repeat(3, 1fr); }
        .step:not(:last-child)::after { display: none; }
      }
      @media (max-width: 650px) {
        .shell { width: min(100% - 1.5rem, 1180px); }
        .topline .shell { padding: .55rem 0; font-size: .71rem; text-align: center; }
        .nav-links a:not(.nav-github) { display: none; }
        .hero { padding: 4.1rem 0 3.4rem; }
        h1 { font-size: clamp(3rem, 15vw, 4.5rem); }
        .report-window img { min-height: 32rem; }
        .trust-strip { grid-template-columns: 1fr; margin-bottom: 5rem; }
        .trust-strip div + div { border-top: 1px solid var(--line); border-left: 0; }
        .steps, .principles, .report-grid { grid-template-columns: 1fr; }
        .principles { padding: 5.5rem 0; }
        .principle { min-height: auto; }
        .demo { grid-template-columns: 1fr; margin-bottom: 5rem; }
        .demo-badge { display: none; }
        .footer-row { align-items: flex-start; flex-direction: column; }
      }
      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
        *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; }
      }
    </style>
  </head>
  <body>
    <div class="topline"><div class="shell">Built for developers who need evidence before they merge.</div></div>
    <header>
      <nav class="shell" aria-label="Primary navigation">
        <a class="brand" href="#top" aria-label="PR Impact Analysis home">
          <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="18" r="2"/><path d="m6.8 7.1 3.7 9M17.1 6.6 13.8 16M7 6.2l10-.8"/></svg></span>
          PR Impact Analysis
        </a>
        <div class="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#reports">Reports</a>
          <a class="nav-github" href="${README_URL}" target="_blank" rel="noopener noreferrer">README &amp; setup ↗</a>
        </div>
      </nav>
    </header>

    <main id="top">
      <div class="shell">
        <section class="hero" aria-labelledby="hero-heading">
          <div>
            <p class="eyebrow">Evidence-backed PR guidance</p>
            <h1 id="hero-heading">Know what to <span class="gradient-text">verify</span> before merging.</h1>
            <p class="lede">PR Impact Analysis traces pull-request changes through your codebase, identifies the routes that can truly be reached, and posts practical verification guidance directly on the PR.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#reports">See real reports <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
              <a class="button button-secondary" href="${ARCHITECTURE_URL}" target="_blank" rel="noopener noreferrer">Explore the architecture ↗</a>
            </div>
            <p class="proof"><span><b class="check">✓</b> Deterministic graph evidence</span><span><b class="check">✓</b> GPT-5.6, bounded by source citations</span></p>
          </div>

          <a class="report-window" href="/images/PR-1.png" target="_blank" rel="noopener noreferrer" aria-label="Open a full-size example PR Impact Analysis pull request report">
            <div class="window-bar" aria-hidden="true"><span class="window-dots"><i></i><i></i><i></i></span><span class="window-pill">github.com · pull request</span></div>
            <img src="/images/PR-1.png" alt="A PR Impact Analysis pull request report showing changes, verification guidance, and technical evidence." />
            <span class="report-label">A real sticky PR comment ↗</span>
          </a>
        </section>

        <div class="trust-strip" aria-label="Product guarantees">
          <div><strong>Reachability is proven</strong><span>Resolved module relationships, not a guessed dependency list.</span></div>
          <div><strong>AI is constrained</strong><span>It explains supplied PR context; it does not invent impact claims.</span></div>
          <div><strong>Noise is prioritized</strong><span>Shared UI, styling, and analytics stay technical instead of flooding checks.</span></div>
        </div>

        <section id="how-it-works" aria-labelledby="how-heading">
          <div class="section-intro">
            <p class="section-tag">How it works</p>
            <h2 id="how-heading">A verification plan with a chain of evidence.</h2>
            <p>PR Impact Analysis combines deterministic graph analysis with carefully bounded GPT-5.6 interpretation. Each layer has one job, so developers can inspect why a recommendation appears.</p>
          </div>
          <div class="steps">
            <article class="step"><span class="step-number">01</span><h3>Read the PR</h3><p>Exact changed files, symbols, and line-level hunks are gathered from the base and head commits.</p></article>
            <article class="step"><span class="step-number">02</span><h3>Trace the graph</h3><p>Resolved imports reveal which routes, APIs, and applications can be reached by the change.</p></article>
            <article class="step"><span class="step-number">03</span><h3>Prioritize impact</h3><p>Technical roles separate application behavior from UI primitives, styling, analytics, and configuration.</p></article>
            <article class="step"><span class="step-number">04</span><h3>Ground the guidance</h3><p>GPT-5.6 receives only selected hunks and route context to phrase practical checks.</p></article>
            <article class="step"><span class="step-number">05</span><h3>Update the PR</h3><p>One sticky GitHub comment keeps the latest report visible as the pull request changes.</p></article>
          </div>
        </section>

        <section class="principles" aria-label="Why developers can trust the report">
          <article class="principle">
            <div class="icon-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 5 6v5c0 4.4 2.9 8.5 7 10 4.1-1.5 7-5.6 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg></div>
            <h3>Evidence before explanation</h3>
            <p>The module graph—not the model—is the authority for which routes and APIs are affected.</p>
          </article>
          <article class="principle">
            <div class="icon-box violet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="7"/></svg></div>
            <h3>Useful, not noisy</h3>
            <p>Product behavior is promoted. Analytics, styling, shared UI, and configuration remain visible as technical context.</p>
          </article>
          <article class="principle">
            <div class="icon-box blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 17 17 7M7 7h10v10"/><path d="M5 4h6M4 5v15h15v-6"/></svg></div>
            <h3>Built into review</h3>
            <p>There is no new dashboard to remember. The current report lives in the pull request your team is already reviewing.</p>
          </article>
        </section>

        <section id="reports" class="reports" aria-labelledby="reports-heading">
          <div class="section-intro">
            <p class="section-tag">Product in action</p>
            <h2 id="reports-heading">Reports that answer the next question.</h2>
            <p>Instead of a long dependency list, developers see the changed behavior, the routes worth checking, and expandable evidence for when they need to investigate.</p>
          </div>
          <div class="report-grid">
            <a class="report-card" href="/images/PR-1.png" target="_blank" rel="noopener noreferrer">
              <div class="preview"><img src="/images/PR-1.png" alt="Example pull request impact report for seller review requests and management flows." /></div>
              <div class="report-card-copy"><small>Example report 01</small><h3>Seller review requests and management</h3><p>Changed application behavior is tied to verification guidance and an auditable impact map.</p></div>
            </a>
            <a class="report-card" href="/images/PR-2.png" target="_blank" rel="noopener noreferrer">
              <div class="preview"><img src="/images/PR-2.png" alt="Example pull request impact report for Reddit review submission and seller-profile actions." /></div>
              <div class="report-card-copy"><small>Example report 02</small><h3>Reddit review submission and seller profile</h3><p>Route-specific checks stay concise, while technical evidence remains available on demand.</p></div>
            </a>
          </div>
        </section>

        <section class="demo" aria-labelledby="demo-heading">
          <div>
            <p class="section-tag">Evidence-first PR review</p>
            <h2 id="demo-heading">A dependable second set of eyes before merge.</h2>
            <p>PR Impact Analysis combines deterministic graph evidence with GPT-5.6 guidance. The model receives only bounded, cited PR context and cannot establish impact on its own.</p>
            <div class="demo-actions">
              <a class="button button-primary" href="${README_URL}" target="_blank" rel="noopener noreferrer">Read the README &amp; setup guide ↗</a>
              <a class="button button-secondary" href="${ARCHITECTURE_URL}" target="_blank" rel="noopener noreferrer">Read architecture docs ↗</a>
            </div>
          </div>
          <div class="demo-badge" aria-hidden="true"><em>Graph + AI</em>Evidence<br />first</div>
        </section>
      </div>
    </main>

    <footer>
      <div class="shell footer-row">
        <span>PR Impact Analysis · Evidence-backed PR verification</span>
        <div class="footer-links"><a href="${README_URL}" target="_blank" rel="noopener noreferrer">README &amp; setup</a><a href="${ARCHITECTURE_URL}" target="_blank" rel="noopener noreferrer">Architecture</a><a href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">GitHub</a><a href="/health">Health</a></div>
      </div>
    </footer>
  </body>
</html>`;
}
