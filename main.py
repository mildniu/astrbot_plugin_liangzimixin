from astrbot.api import star


@star.register(
    "astrbot_plugin_liangzimixin",
    "Local Adaptation",
    "量子密信平台适配器",
    "0.1.0",
)
class LiangzimixinPlugin(star.Star):
    def __init__(self, context: star.Context) -> None:
        super().__init__(context)
        from . import liangzimixin_adapter  # noqa: F401
