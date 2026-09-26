{{--
    Mutual fund assistant — embed snippet.

    1. Copy this file to resources/views/partials/mf-chat.blade.php
    2. In your main layout (e.g. resources/views/layouts/app.blade.php), just before </body>:
           @include('partials.mf-chat')
    3. Optional, on a fund detail page so "this fund" works:
           @include('partials.mf-chat', ['mfChatSchemeCode' => $fund->scheme_code, 'mfChatSchemeName' => $fund->name])
       Inline panel instead of the floating button (include only once per page):
           <div id="fund-chat" style="height: 600px"></div>
           @include('partials.mf-chat', ['mfChatMode' => 'inline', 'mfChatTarget' => '#fund-chat'])

    Needs in config/services.php:
        'mf_chat' => ['url' => env('MF_CHAT_URL'), 'secret' => env('MF_CHAT_SECRET')],
--}}
@php
    $mfChatUrl = rtrim((string) config('services.mf_chat.url'), '/');
    $mfChatSecret = (string) config('services.mf_chat.secret');
    $mfChatToken = null;

    // Signed, short-lived token proving which user is logged in (verified by the Node service).
    if ($mfChatSecret !== '' && auth()->check()) {
        $mfChatPayload = rtrim(strtr(base64_encode(json_encode([
            'uid'  => (string) auth()->id(),
            'name' => \Illuminate\Support\Str::before(trim((string) (auth()->user()->name ?? '')), ' '),
            'exp'  => time() + 60 * 60 * 12,
        ])), '+/', '-_'), '=');
        $mfChatToken = $mfChatPayload.'.'.hash_hmac('sha256', $mfChatPayload, $mfChatSecret);
    }
@endphp

@if ($mfChatUrl !== '')
    <script
        src="{{ $mfChatUrl }}/embed.js"
        @if ($mfChatToken) data-token="{{ $mfChatToken }}" @endif
        data-title="{{ config('app.name') }} Assistant"
        @isset($mfChatSchemeCode) data-scheme-code="{{ $mfChatSchemeCode }}" @endisset
        @isset($mfChatSchemeName) data-scheme-name="{{ $mfChatSchemeName }}" @endisset
        @isset($mfChatMode) data-mode="{{ $mfChatMode }}" @endisset
        @isset($mfChatTarget) data-target="{{ $mfChatTarget }}" @endisset
        defer
    ></script>
@endif
