# ADR-0005: Generic ARIA adapters before framework-specific ones

Status: accepted

Decision: implement one ARIA combobox/listbox adapter (aria-controls scoping, overlay lookup, exact-match first, editable autocomplete) instead of separate Angular Material / PrimeNG code paths. Framework detection is reported in snapshots for context.
Consequences: works for any WAI-ARIA widget; framework adapters will only be added where a fixture demonstrates a measurable failure of the generic path (roadmap).
