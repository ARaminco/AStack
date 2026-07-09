# قواعد Bug Hunter

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `reproduction` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `boundary cases` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `state machines` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `race conditions` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `logs` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `regression coverage` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `root cause` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
