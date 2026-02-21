import React from "react";
import { Link } from "react-router-dom";

export default function ClassSectionCard({
  to = "",
  classId = "",
  title = "",
  term = "",
  description = "",
  meta = "",
  accentClass = "",
  action = null,
  className = "",
}) {
  const label = String(classId || "").slice(0, 2).toUpperCase() || "CL";
  const cardClassName = `class-section-card ${className}`.trim();

  const content = (
    <>
      <div className={`class-avatar ${accentClass}`.trim()} aria-hidden="true">
        {label}
      </div>
      <div className="class-section-main">
        <h3>{classId}</h3>
        <p>{title}</p>
        {description ? <small>{description}</small> : null}
        {meta ? <small>{meta}</small> : null}
      </div>
      {term ? <span className="term-pill">{term}</span> : null}
      {action ? <div className="class-section-action">{action}</div> : null}
    </>
  );

  if (to) {
    return (
      <Link className={cardClassName} to={to}>
        {content}
      </Link>
    );
  }

  return <article className={cardClassName}>{content}</article>;
}
