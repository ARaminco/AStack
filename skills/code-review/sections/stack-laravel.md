# Laravel 12, Livewire 3, Filament

Check the installed versions in `composer.lock` first; verify any API you cite
against that version's documentation.

## Laravel 12
- **Mass assignment:** `$guarded = []`, `Model::unguard()`, or `$fillable`
  containing `role`, `is_admin`, `tenant_id`, `balance`. `create($request->all())`
  or `update($request->all())` instead of `$request->validated()`.
- **Raw SQL:** `DB::raw`, `whereRaw`, `orderByRaw`, `selectRaw` with interpolated
  input; `orderBy($request->sort)` without a column allowlist.
- **Authorization:** controller actions without `Gate::authorize()` /
  `$this->authorize()` or a policy; FormRequest `authorize()` returning `true`
  where ownership matters; route model binding of nested resources without
  `scopeBindings()` (IDOR).
- **Validation:** missing rules on new fields; `exists:` / `unique:` rules not
  scoped to the tenant; file rules without `mimes`/`max`.
- **Config:** `env()` called outside `config/` (returns null after
  `config:cache`); secrets or keys committed to `config/*.php`.
- **Eager loading:** relations in loops or Blade without `with()`/`load()`/
  `withCount()`. `Model::preventLazyLoading(! app()->isProduction())` catches it.
- **Queues:** jobs dispatched inside a DB transaction without `afterCommit`;
  non-idempotent jobs with `tries > 1`; `timeout` not below the connection's
  `retry_after`; `ShouldBeUnique` missing where duplicates cost money; mail or
  HTTP calls inline in a request instead of queued.
- **Migrations:** see `data-migration.md`; also `down()` missing or a no-op, and
  `->change()` without checking the driver's support.
- **Caching:** `Cache::remember` keys that omit user or tenant; tags on a store
  that does not support them.
- **Blade:** `{!! !!}` on user data; `@php` blocks doing queries.
- **Storage:** private documents on the `public` disk or served by
  `Storage::url`; use temporary signed URLs.
- **Rate limits:** login, OTP, password reset and public API routes without a
  `RateLimiter::for` / `throttle` middleware.

## Livewire 3
- Public properties are client-editable input. IDs and prices need `#[Locked]`;
  every action re-authorizes (`$this->authorize(...)`), not only `mount()`.
- `#[Url]` properties and action arguments are user input: validate them.
- `wire:model.live` on text inputs floods the server; prefer `.blur` or
  `.live.debounce`.
- Queries in `render()` without eager loading; heavy work not in `#[Computed]`.
- `WithFileUploads` without `mimes`/`max` validation; temporary uploads assumed
  private.
- `legacy_model_binding` enabled, binding Eloquent attributes straight to inputs.

## Filament
- `User` implements `FilamentUser` with `canAccessPanel()` returning `true` for
  everyone; panel reachable by any registered user.
- Resources without a policy, or `canViewAny`/`canEdit` overrides that skip
  ownership; relation managers and bulk actions that skip per-record checks.
- Tenancy: `getEloquentQuery()` not scoped to the tenant; global scopes removed
  (`withoutGlobalScopes()`) in a resource query.
- A field hidden or disabled in the form is not authorization: the model's
  fillable and the policy still decide.
- Destructive actions without `->requiresConfirmation()`.
- `FileUpload` storing private files on a public disk (set `->disk()` and
  `->visibility('private')`).
- Tables with `->searchable()` / `->sortable()` on unindexed or computed
  columns; missing eager loading in `modifyQueryUsing`.
- After a Filament upgrade, `php artisan filament:upgrade` and published assets.
