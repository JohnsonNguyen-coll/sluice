# Sluice visual direction

Sluice is payment infrastructure for AI agents on Arc. The landing helps developers understand prefunding, spending policies, off-chain vouchers and batched settlement, then reach the docs or dashboard.

## Identity
Preserve the Sluice mark, Geist and Geist Mono, graphite/periwinkle dark palette and cool-white/indigo light palette. Dark Veil stays in the hero at speed 2, with no pause control. Respect system reduced-motion settings.

## Hierarchy and layout
Use a centered hero, one clear primary action, a payment-flow heading above an open horizontal Agent → Provider → Arc sequence before spending controls, a provider-budget demo, a developer explanation/code split and a compact release strip. Animate the payment-path connectors below the hero. Stack stages vertically below 760px. Do not wrap the whole diagram in a card or stretch a description column to match its height; preserve the newer lower sections. Keep surfaces purposeful: code and the payment rail may have borders; ordinary explanations should use spacing and rules. Do not turn every paragraph into a card.

## Typography
Body copy 16px, secondary descriptions 14–15px, captions 12px and short uppercase technical labels 11px. Headlines scale responsively with balanced wrapping. Use mono for contract/code detail and small section labels. Never shrink body copy to fit a layout.

## Interaction
Navigation, CTAs, theme select and copy buttons have at least 44px height. Keep visible keyboard focus. Use subtle arrow movement on hover, without moving surrounding layout. Collapse the desktop nav on small screens and let content stack without horizontal scrolling.

## Product truth
Separate testnet deployments from integrations in progress. Code examples must match local contracts. Do not invent customers, usage figures, balances, testimonials or production readiness. Preserve all routes and wallet behavior.

## References
This project-specific direction was informed by:
- https://github.com/VoltAgent/awesome-design-md (Linear design analysis: type hierarchy, surface restraint, product detail)
- https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (readability, touch targets, responsive layout)
- https://github.com/pbakaus/impeccable (critique, distillation, deliberate hierarchy)

These are design references; their CLIs, hooks and plugins are not installed.

## Code
Use semantic syntax tokens for comments, keywords, types, strings, numbers and function names. Define separate light/dark colors. Preserve exact code text for copying; unknown languages fall back to plain text.

## Navigation
The landing header is a fixed, centered, translucent floating frame with a bounded width. Dark Veil starts at the viewport top behind it; reserve hero padding so content clears the header. Other public routes keep their existing header. App routes use one full-width sticky header row containing the Sluice brand, navigation and controls. Do not add a second navigation row or a workspace sidebar. Below 1100px, a menu button opens the same navigation as a dropdown. Omit AgentPay and network badges from the header. Preserve active route indicators, search, theme and wallet controls.

The payment-flow section omits the settlement footnote and Protocol concept caption beneath the stages.
