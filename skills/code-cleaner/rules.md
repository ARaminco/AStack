# قواعد Code Cleaner

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `dead code` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `naming` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `duplication` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `coupling` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `small functions` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `clear errors` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `format consistency` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
