# Workflow رفع Bug

## سیاست زبان
این workflow باید `../system/language-policy.md` را رعایت کند. توضیح، سوال، هشدار، تحلیل و گزارش فارسی است؛ commandها و دارایی‌های نرم‌افزاری انگلیسی می‌مانند.

## فرمان
`/bug-fix`

## هدف
اجرای یک فرآیند تکرارپذیر در AStack که توسط Claude Code، OpenAI Codex، ChatGPT یا agentهای آینده قابل‌خواندن باشد.

## مراحل
1. بازآفرینی خطا
2. ایزوله‌سازی علت
3. اصلاح
4. تست regression
5. بازبینی
6. یادداشت release

## skillهای مورد استفاده
- bug-hunter
- testing-review
- code-cleaner

## معیار تکمیل
- scope صریح است.
- ریسک معماری و implementation نام‌گذاری شده است.
- تست‌ها مشخص یا پیاده‌سازی شده‌اند.
- documentation و release notes در صورت نیاز به‌روزرسانی شده‌اند.
- پاسخ نهایی شامل تغییرات، verification و residual risk است.
