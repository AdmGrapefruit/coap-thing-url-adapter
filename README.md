# coap-thing-url-adapter

This is an adapter add-on for the [Mozilla WebThings Gateway](https://github.com/mozilla-iot/gateway) that allows a user to discover CoAP-based web things on their network.

Based on [thing-url-adapter](https://github.com/mozilla-iot/thing-url-adapter) by Mozilla IoT.

## Notes

If you're trying to **MANUALLY** add a server (e.g. if mDNS discovery isn't working) that contains multiple web things, i.e. the "multiple-coap-things" example from the [webthing-node](https://github.com/AdmGrapefruit/webthing-node) library, you'll have to add them individually. You can do so by addressing them numerically, i.e. `coap://myserver.local:5683/0` and `coap://myserver.local:5683/1`.
