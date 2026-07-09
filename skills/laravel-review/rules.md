# قواعد بازبینی Laravel

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `N+1 queries` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Repository Pattern` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Service Layer` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Policies` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Validation` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Filament Resources` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Livewire Components` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Events` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Queues` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Redis` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Caching` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Eloquent` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Security` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Performance` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Pest` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
