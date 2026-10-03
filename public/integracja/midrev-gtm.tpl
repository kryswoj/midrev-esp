___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "MidRev Tracking",
  "categories": ["EMAIL_MARKETING", "PERSONALIZATION"],
  "brand": {
    "id": "brand_dummy",
    "displayName": "MidRev"
  },
  "description": "Skrypt midrev.js: rozpoznawanie osób, oglądane produkty, koszyk i formularze. Zdarzenia GA4 ecommerce z dataLayer odczytuje sam (po włączeniu w panelu MidRev). Reguła: All Pages.",
  "containerContexts": [
    "WEB"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "siteKey",
    "displayName": "Klucz strony (company_id) z panelu MidRev",
    "simpleValueType": true,
    "valueValidators": [
      {
        "type": "REGEX",
        "args": [
          "^[A-Za-z0-9]{6,10}$"
        ]
      }
    ]
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const injectScript = require('injectScript');
const createQueue = require('createQueue');
const encodeUriComponent = require('encodeUriComponent');

// kolejki komend sprzed załadowania skryptu (jak window.midrev = window.midrev || [])
createQueue('midrev');
createQueue('_learnq');

const url = 'https://link.midrev.pl/js/v1/' + encodeUriComponent(data.siteKey) + '.js';
injectScript(url, data.gtmOnSuccess, data.gtmOnFailure, url);


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "inject_script",
        "versionId": "1"
      },
      "param": [
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "https://link.midrev.pl/js/v1/*"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "access_globals",
        "versionId": "1"
      },
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "key" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" },
                  { "type": 1, "string": "execute" }
                ],
                "mapValue": [
                  { "type": 1, "string": "midrev" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "key" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" },
                  { "type": 1, "string": "execute" }
                ],
                "mapValue": [
                  { "type": 1, "string": "_learnq" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []


___NOTES___

MidRev ESP: szablon tagu do importu (Szablony > Nowy > menu > Importuj). Adres skryptu
na produkcji: link.midrev.pl. Zgoda na cookies: skrypt sam czeka na Google Consent Mode
(analytics_storage) i popularne banery; do tego czasu niczego nie zapisuje.
