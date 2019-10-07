/**
 * example-plugin-adapter.js - ThingURL adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const crypto = require('crypto');
const dnssd = require('dnssd');
const {URL} = require('url');
const coap = require('coap');

const {
  Adapter,
  Constants,
  Database,
  Device,
  Event,
  Property,
} = require('gateway-addon');

let webthingBrowser;
let coapBrowser;

class ThingURLProperty extends Property {
  constructor(device, name, url, propertyDescription) {
    super(device, name, propertyDescription);
    this.url = url;
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
  }

  /**
   * @method setValue
   * @returns {Promise} resolves to the updated value
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    return fetchCoap(this.url, {
      method: 'PUT',
      headers: {
        'Content-Format': 'application/json',
        Accept: 'application/json'
      },
      payload: JSON.stringify( {[this.name]: value} )
    }).then((res) => {
      const payload = JSON.parse(res.payload.toString());
      const updatedValue = payload[this.name];
      this.setCachedValue(updatedValue);
      this.device.notifyPropertyChanged(this);
      return updatedValue;
    }).catch((e) => {
      console.log(`Failed to set ${this.name}: ${e}`);
      return this.value;
    });
  }
}

class ThingURLDevice extends Device {
  constructor(adapter, id, url, description, mdnsUrl) {
    super(adapter, id);
    this.title = this.name = description.title || description.name;
    this.type = description.type;
    this['@context'] =
      description['@context'] || 'https://iot.mozilla.org/schemas';
    this['@type'] = description['@type'] || [];
    this.url = url;
    this.mdnsUrl = mdnsUrl;
    this.actionsUrl = null;
    this.eventsUrl = null;
    this.description = description.description;
    this.propertyPromises = [];
    this.requestedActions = new Map();
    this.notifiedEvents = new Set();
    this.scheduledUpdate = null;
    this.updateInterval = 5000;
    this.closing = false;

    let { protocol, hostname, port } = new URL(url);
    this.baseHref = `${protocol}//${hostname}:${port}`;

    for (const actionName in description.actions) {
      const action = description.actions[actionName];
      if (action.hasOwnProperty('links')) {
        action.links = action.links.map((l) => {
          if (!l.href.startsWith('coap://') && !l.href.startsWith('coaps://')) {
            l.proxy = true;
          }
          return l;
        });
      }
      this.addAction(actionName, action);
    }

    for (const eventName in description.events) {
      const event = description.events[eventName];
      if (event.hasOwnProperty('links')) {
        event.links = event.links.map((l) => {
          if (!l.href.startsWith('coap://') && !l.href.startsWith('coaps://')) {
            l.proxy = true;
          }
          return l;
        });
      }
      this.addEvent(eventName, event);
    }

    for (const propertyName in description.properties) {
      const propertyDescription = description.properties[propertyName];

      let propertyUrl;
      if (propertyDescription.hasOwnProperty('links')) {
        for (const link of propertyDescription.links) {
          if (!link.rel || link.rel === 'property') {
            propertyUrl = this.baseHref + link.href;
            break;
          }
        }
      }

      if (!propertyUrl) {
        if (!propertyDescription.href) {
          continue;
        }

        propertyUrl = this.baseHref + propertyDescription.href;
      }

      this.propertyPromises.push(
        fetchCoap(propertyUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json'
          }
        }).then((res) => {
          const payload = JSON.parse(res.payload.toString());
          propertyDescription.value = payload[propertyName];
          if (propertyDescription.hasOwnProperty('links')) {
            propertyDescription.links = propertyDescription.links.map((l) => {
              if (!l.href.startsWith('coap://') &&
                  !l.href.startsWith('coaps://')) {
                l.proxy = true;
              }
              return l;
            });
          }
          const property = new ThingURLProperty(
              this, propertyName, propertyUrl, propertyDescription);
          this.properties.set(propertyName, property);
          return payload;
        }).catch((e) => {
          console.log(`Failed to connect to ${propertyUrl}: ${e}`);
        })
      );
    }

    if (description.hasOwnProperty('links')) {
      for (const link of description.links) {
        if (link.rel === 'actions') {
          this.actionsUrl = this.baseHref + link.href;
        } else if (link.rel === 'events') {
          this.eventsUrl = this.baseHref + link.href;
        } else if (link.rel === 'properties') {
          // pass
        } else if (link.rel === 'alternate') {
          if (link.mediaType === 'text/html') {
            if (!link.href.startsWith('coap://') &&
                !link.href.startsWith('coaps://')) {
              link.proxy = true;
            }
            this.links.push(link);
          } else {
            this.links.push(link);
          }
        } else {
          if (!link.href.startsWith('coap://') &&
              !link.href.startsWith('coaps://')) {
            link.proxy = true;
          }
          this.links.push(link);
        }
      }
    }

    // Poll the device for updates.
    Promise.all(this.propertyPromises).then(() => this.poll());
  }

  async poll() {
    if (this.closing) {
      return;
    }

    // Update properties
    await Promise.all(Array.from(this.properties.values()).map((prop) => {
      fetchCoap(prop.url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      }).then((res) => {
        const payload = JSON.parse(res.payload.toString());
        const newValue = payload[prop.name];
        prop.getValue().then((value) => {
          if (value !== newValue) {
            prop.setCachedValue(newValue);
            this.notifyPropertyChanged(prop);
          }
        });
        return payload;
      }).catch((e) => {
        console.log(`Failed to connect to ${prop.url}: ${e}`);
      })
    }));

    // Check for new actions
    if (this.actionsUrl !== null) {
      await fetchCoap(this.actionsUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      }).then((res) => {
        const payload = JSON.parse(res.payload.toString());
        for (let action of payload) {
          const actionName = Object.keys(action)[0];
          action = action[actionName];
          const requestedAction =
              this.requestedActions.get(action.href);

          if (requestedAction && action.status !== requestedAction.status) {
            requestedAction.status = action.status;
            requestedAction.timeRequested = action.timeRequested;
            requestedAction.timeCompleted = action.timeCompleted;
            this.actionNotify(requestedAction);
          }
        }
        return payload;
      }).catch((e) => {
        console.log(`Failed to fetch actions list: ${e}`);
      });
    }

    // Check for new events
    if (this.eventsUrl !== null) {
      await fetchCoap(this.eventsUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      }).then((res) => {
        const payload = JSON.parse(res.payload.toString());
        for (let event of payload) {
          const eventName = Object.keys(event)[0];
          event = event[eventName];
          this.createEvent(eventName, event);
        }
        return payload;
      }).catch((e) => {
        console.log(`Failed to fetch events list: ${e}`);
      });
    }

    if (this.scheduledUpdate) {
      clearTimeout(this.scheduledUpdate);
    }
    this.scheduledUpdate = setTimeout(() => this.poll(), this.updateInterval);
  }

  createEvent(eventName, event) {
    const eventId = (event.data && event.data.hasOwnProperty('id')) ?
      event.data.id :
      `${eventName}-${event.timestamp}`;

    if (this.notifiedEvents.has(eventId)) {
      return;
    }
    if (!event.hasOwnProperty('timestamp')) {
      event.timestamp = new Date().toISOString();
    }
    this.notifiedEvents.add(eventId);
    const e = new Event(this,
                        eventName,
                        event.data || null);
    e.timestamp = event.timestamp;

    this.eventNotify(e);
  }

  performAction(action) {
    action.start();

    return fetchCoap(this.actionsUrl, {
      method: 'POST',
      headers: {
        'Content-Format': 'application/json',
        Accept: 'application/json'
      },
      payload: JSON.stringify({[action.name]: {input: action.input}})
    }).then((res) => {
      const payload = JSON.parse(res.payload.toString());
      this.requestedActions.set(res[action.name].href, action);
      return payload;
    }).catch((e) => {
      console.log(`Failed to perform action: ${e}`);
      action.status = 'error';
      this.actionNotify(action);
    });
  }

  cancelAction(actionId, actionName) {
    let promise;

    this.requestedActions.forEach((action, actionHref) => {
      if (action.name === actionName && action.id === actionId) {
        promise = fetchCoap(actionHref, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json'
          }
        }).catch((e) => {
          console.log(`Failed to cancel action: ${e}`);
        });

        this.requestedActions.delete(actionHref);
      }
    });

    if (!promise) {
      promise = Promise.resolve();
    }

    return promise;
  }
}

class CoapThingUrlAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, packageName, packageName);
    addonManager.addAdapter(this);
    this.knownUrls = {};
  }

  async loadThing(url, retryCounter) {
    if (typeof retryCounter === 'undefined') {
      retryCounter = 0;
    }

    url = url.replace(/\/$/, '');

    if (!this.knownUrls[url]) {
      this.knownUrls[url] = {
        digest: '',
        timestamp: 0,
      };
    }

    if (this.knownUrls[url].timestamp + 5000 > Date.now()) {
      return;
    }

    let res;
    try {
      res = await fetchCoap(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });
    } catch (e) {
      // Retry the connection at a 2 second interval up to 5 times.
      if (retryCounter >= 5) {
        console.log(`Failed to connect to ${url}: ${e}`);
      } else {
        setTimeout(() => this.loadThing(url, retryCounter + 1), 2000);
      }
      return;
    }

    const text = res.payload.toString();

    const hash = crypto.createHash('md5');
    hash.update(text);
    const dig = hash.digest('hex');
    let known = false;
    if (this.knownUrls[url].digest === dig) {
      known = true;
    }

    this.knownUrls[url] = {
      digest: dig,
      timestamp: Date.now(),
    };

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log(`Failed to parse description at ${url}: ${e}`);
      return;
    }

    let things;
    if (Array.isArray(data)) {
      things = data;
    } else {
      things = [data];
    }

    for (const thingDescription of things) {
      let thingUrl = url;
      if (thingDescription.hasOwnProperty('href')) {
        let { protocol, hostname, port } = new URL(url);
        const baseHref = `${protocol}//${hostname}:${port}`;
        thingUrl = baseHref + thingDescription.href;
      }

      const id = thingUrl.replace(/[:/]/g, '-');
      if (id in this.devices) {
        if (known) {
          continue;
        }
        await this.removeThing(this.devices[id]);
      }
      await this.addDevice(id, thingUrl, thingDescription, url);
    }
  }

  unloadThing(url) {
    url = url.replace(/\/$/, '');

    for (const id in this.devices) {
      const device = this.devices[id];
      if (device.mdnsUrl === url) {
        this.removeThing(device);
      }
    }

    if (this.knownUrls[url]) {
      delete this.knownUrls[url];
    }
  }

  /**
   * Add a ThingURLDevice to the CoapThingUrlAdapter
   *
   * @param {String} deviceId ID of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceURL, description, mdnsUrl) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject(`Device: ${deviceId} already exists.`);
      } else {
        const device =
          new ThingURLDevice(this, deviceId, deviceURL, description, mdnsUrl);
        Promise.all(device.propertyPromises).then(() => {
          this.handleDeviceAdded(device);
          resolve(device);
        }).catch((e) => reject(e));
      }
    });
  }

  /**
   * Remove a ThingURLDevice from the CoapThingUrlAdapter.
   *
   * @param {Object} device The device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeThing(device) {
    return this.removeDeviceFromConfig(device).then(() => {
      if (this.devices.hasOwnProperty(device.id)) {
        this.handleDeviceRemoved(device);
        return device;
      } else {
        throw new Error(`Device: ${device.id} not found.`);
      }
    });
  }

  /**
   * Remove a device's URL from this adapter's config if it was manually added.
   *
   * @param {Object} device The device to remove.
   */
  async removeDeviceFromConfig(device) {
    try {
      const db = new Database(this.packageName);
      await db.open();
      const config = await db.loadConfig();

      // If the device's URL is saved in the config, remove it.
      const urlIndex = config.urls.indexOf(device.url);
      if (urlIndex >= 0) {
        config.urls.splice(urlIndex, 1);
        await db.saveConfig(config);

        // Remove from list of known URLs as well.
        const adjustedUrl = device.url.replace(/\/$/, '');
        if (this.knownUrls.hasOwnProperty(adjustedUrl)) {
          delete this.knownUrls[adjustedUrl];
        }
      }
    } catch (err) {
      console.error(`Failed to remove device ${device.id} from config: ${err}`);
    }
  }

  startPairing() {
    for (const knownUrl in this.knownUrls) {
      this.loadThing(knownUrl).catch((err) => {
        console.warn(`Unable to reload Thing(s) from ${knownUrl}: ${err}`);
      });
    }
  }

  unload() {
    if (webthingBrowser) {
      webthingBrowser.stop();
    }

    if (coapBrowser) {
      coapBrowser.stop();
    }

    return super.unload();
  }
}

function startDNSDiscovery(adapter) {
  console.log('Starting mDNS discovery');

  webthingBrowser =
    new dnssd.Browser(new dnssd.ServiceType('_webthing._udp'));
  webthingBrowser.on('serviceUp', (service) => {
    const host = service.host.replace(/\.$/, '');
    adapter.loadThing(`coap://${host}:${service.port}${service.txt.path}`);
  });
  webthingBrowser.on('serviceDown', (service) => {
    const host = service.host.replace(/\.$/, '');
    adapter.unloadThing(`coap://${host}:${service.port}${service.txt.path}`);
  });
  webthingBrowser.start();

  coapBrowser = new dnssd.Browser(new dnssd.ServiceType('_coap._udp'));
  coapBrowser.on('serviceUp', (service) => {
    if (typeof service.txt === 'object' &&
        service.txt.hasOwnProperty('webthing')) {
      adapter.loadThing(service.txt.url);
    }
  });
  coapBrowser.on('serviceDown', (service) => {
    if (typeof service.txt === 'object' &&
        service.txt.hasOwnProperty('webthing')) {
      adapter.unloadThing(service.txt.url);
    }
  });
  coapBrowser.start();
}

function loadThingURLAdapter(addonManager, manifest, _errorCallback) {
  const adapter = new CoapThingUrlAdapter(addonManager, manifest.name);

  for (const url of manifest.moziot.config.urls) {
    adapter.loadThing(url);
  }

  startDNSDiscovery(adapter);
}

function fetchCoap(url, options) {
  return new Promise((resolve) => {
    const { hostname, port, pathname } = new URL(url);
    const urlOptions = { host: hostname, port: port, pathname: pathname };
    const req = coap.request(Object.assign({}, urlOptions, options));

    req.on('response', (res) => {
      req.removeAllListeners();
      resolve(res);
    });

    req.on('timeout', (e) => {
      req.removeAllListeners();
      throw e;
    });

    req.on('error', (e) => {
      req.removeAllListeners();
      throw e;
    });

    if (!options.payload) {
      req.end();
    } else {
      req.end(options.payload);
    }
  });
}

module.exports = loadThingURLAdapter;
