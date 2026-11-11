const marks = [
  { className: "mark mark-one", label: "A soft circle suspended in the dark" },
  { className: "mark mark-two", label: "A small point of light" },
  { className: "mark mark-three", label: "A distant colored haze" },
];

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <a aria-label="Interact with Nothingness home" className="wordmark" href="/">
          <span className="wordmark-symbol" aria-hidden="true">
            ◌
          </span>
          <span>IN / N</span>
        </a>
        <span className="topbar-note">An ongoing experiment · 2026</span>
      </header>

      <section aria-labelledby="hero-title" className="hero">
        <div aria-hidden="true" className="artwork">
          <div className="artwork-grain" />
          {marks.map((mark) => (
            <span
              aria-label={mark.label}
              className={mark.className}
              key={mark.className}
              role="img"
            />
          ))}
          <span aria-hidden="true" className="artwork-caption">
            FIG. 001 &nbsp; / &nbsp; BEFORE THE FIRST PROMPT
          </span>
        </div>

        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" />
            A space for imagined things
          </p>
          <h1 id="hero-title">
            Interact with
            <br />
            <span>Nothingness.</span>
          </h1>
          <p className="intro">
            What can emerge from an empty space? An ongoing experiment exploring
            the meeting point of artificial intelligence, human intention, and
            generative art.
          </p>
          <a className="text-link" href="#about">
            Enter the idea <span aria-hidden="true">↘</span>
          </a>
        </div>
        <span aria-hidden="true" className="hero-index">
          01 — 03
        </span>
      </section>

      <section aria-labelledby="about-title" className="about" id="about">
        <p className="eyebrow">A beginning, not an answer</p>
        <h2 id="about-title">First, there is room.</h2>
        <p>
          This project is taking shape: a place to explore how prompts, models,
          and creative choices might turn absence into something unexpected.
          The canvas is still open.
        </p>
        <span className="about-index">A STUDY IN POSSIBILITY &nbsp; / &nbsp; 001</span>
      </section>

      <footer className="footer">
        <span>INTERACT WITH NOTHINGNESS</span>
        <span>MADE TO ASK, NOT TO ANSWER</span>
      </footer>
    </main>
  );
}
