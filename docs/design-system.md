# TeamFinder Design System (Phase 1)

## Principles
- Functional first: every screen should expose core class/team workflows with minimal clicks.
- Readable under load: high-contrast text and clear section boundaries.
- Event visibility: user actions should produce visible feedback immediately.

## Tokens
- Background: `#0f172a`
- Panel: `#111827`
- Panel alt: `#1f2937`
- Text: `#e5e7eb`
- Accent: `#22c55e`
- Error: `#ef4444`

## Typography
- Primary font: IBM Plex Sans fallback to Segoe UI/sans-serif.
- Headings: compact and left-aligned for scanning.

## Layout
- Responsive card grid (`minmax(340px, 1fr)`).
- Each domain (Auth, Profile, Classes, Messaging, Recommendations) gets a dedicated card.

## Components
- Inputs and buttons share border radius and color system.
- `pre` panels are used for event/log output during Phase 1.
- Pill indicator for active user identity.

## Next Iteration Standards
- Replace raw form sections with reusable components.
- Add accessibility labels and keyboard-first navigation.
- Add dark/light themes with token swap only.
