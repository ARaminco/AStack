# Workflow ویژگی Laravel

## سیاست زبان
این workflow باید `../system/language-policy.md` را رعایت کند. توضیح، سوال، هشدار، تحلیل و گزارش فارسی است؛ commandها و دارایی‌های نرم‌افزاری انگلیسی می‌مانند.

## فرمان
`/laravel-review`

## هدف
اجرای یک فرآیند تکرارپذیر در AStack که توسط Claude Code، OpenAI Codex، ChatGPT یا agentهای آینده قابل‌خواندن باشد.

## مراحل
1. domain slice
2. migration
3. model/policy/validation
4. service یا action
5. UI یا API
6. Pest tests
7. بازبینی

## skillهای مورد استفاده
- laravel-review
- database-review
- security-review
- testing-review

## معیار تکمیل
- scope صریح است.
- ریسک معماری و implementation نام‌گذاری شده است.
- تست‌ها مشخص یا پیاده‌سازی شده‌اند.
- documentation و release notes در صورت نیاز به‌روزرسانی شده‌اند.
- پاسخ نهایی شامل تغییرات، verification و residual risk است.
