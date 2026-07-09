# بازبینی Node.js

## سیاست مشترک
این skill سیاست زبان مرکزی را از `../../system/language-policy.md` inherit می‌کند و نباید قواعد زبان را داخل خود تکرار کند.

## ماموریت
این skill برای ارزیابی حرفه‌ای حوزه‌ی بازبینی Node.js استفاده می‌شود و باید خروجی قابل‌اقدام، دقیق و مناسب production تولید کند.

## چه زمانی استفاده شود
- وقتی تغییر، review یا برنامه‌ریزی به بازبینی Node.js مربوط است.
- وقتی ریسک correctness، security، performance، maintainability یا release وجود دارد.
- وقتی باید یافته‌ها با evidence، impact و remediation مشخص گزارش شوند.

## پروتکل اجرا
1. ابتدا context، source، configuration، tests و documentation مرتبط را بخوان.
2. رفتار قابل‌مشاهده، قراردادهای سیستم و ریسک عملیاتی را مشخص کن.
3. یافته‌ها را با severity، evidence، impact و راه‌حل پیشنهادی بنویس.
4. تمام بخش‌های خروجی را با سیاست زبان مرکزی منطبق کن.
5. در پایان verification و residual risk را گزارش کن.

## محورهای اصلی
- TypeScript correctness
- async error handling
- input validation
- package risk
- observability
- worker behavior
- runtime compatibility

## قالب خروجی
- نتیجه‌ی کلی
- یافته‌ها به ترتیب شدت
- دلیل و اثر هر یافته
- راه‌حل پیشنهادی
- تست‌ها و commandهای لازم برای verification
- ریسک باقی‌مانده
