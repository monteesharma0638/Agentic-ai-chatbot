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

    // Standard JWT (HS256), short-lived, proving which user is logged in (verified by the Node service,
    // which reads the user id from the `sub` claim). base64url with no padding, exactly as JWT requires.
    if ($mfChatSecret !== '' && auth()->check()) {
        $b64url = static fn (string $s): string => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
        $mfChatHeader = $b64url(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
        $mfChatPayload = $b64url(json_encode([
            'sub'  => (string) auth()->id(),
            'name' => \Illuminate\Support\Str::before(trim((string) (auth()->user()->name ?? '')), ' '),
            'iat'  => time(),
            'exp'  => time() + 60 * 60 * 12,
        ]));
        $mfChatSigningInput = $mfChatHeader.'.'.$mfChatPayload;
        $mfChatToken = $mfChatSigningInput.'.'.$b64url(hash_hmac('sha256', $mfChatSigningInput, $mfChatSecret, true));
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
