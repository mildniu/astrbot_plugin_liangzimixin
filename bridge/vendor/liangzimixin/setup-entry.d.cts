import * as openclaw_plugin_sdk from 'openclaw/plugin-sdk';

/**
 * openclaw-liangzimixin — Setup 入口
 *
 * 轻量级入口，用于 `openclaw configure/onboard`。
 * 只注册 channel plugin 对象（含 onboarding adapter），
 * 不加载完整的运行时依赖（crypto、auth、transport 等）。
 */
declare const _default: {
    plugin: openclaw_plugin_sdk.ChannelPlugin<unknown>;
};

export { _default as default };
