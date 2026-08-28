# overview

this folder contains a bunch of utilities i’ve been using to maintain a Shopify product catalog on behalf of a client. they are an aviation and military coatings company and they use AccountMate as their primary ERP; while it provides for flexible CSV export options, maintaining parity between the Shopify catalog and the AccountMate system is difficult because the current export format from AccountMate and Shopify are not compatible, and, frankly, because the source data from AccountMate is very inconsistent, incomplete, and often incorrect (although, sometimes what seems incorrect or inconsistent IS actually correct, because they don’t keep an organized warehouse).

# request

i’d like to generate a new helper script that helps me update the shopify catalog based on the latest from accountmate.

as input, i’ll provide two files:

- an AccountMate export CSV - this reflects the latest from the client’s ERP that should be used to update Shopify
- a Shopify export CSV - this reflects the latest in Shopify, should be the baseline for the “diffs” and eventual reimport file

as output, i’d like three files:

- deleted-products-{date}-{version}.csv
- updated-products-{date}-{version}.csv
- new-products-{date}-{version}.csv

# details

the common key between the two files is the SKU - this can be used to join rows in the AccountMate CSV and the Shopify export CSV (“SKU” column in AccountMate, and “Variant SKU” in Shopify)

i expect to run this daily/every few days, as our website is relatively new. catalog size is currently 80 SKUs…. it will increase to hundreds in the next couple months, and possibly a couple thousand by year end.

this doesn’t need to be completely automated - as i mentioned about volume, it’s low enough to handle some things manually now, so if it adds a ton of complexity to automate and handle edge cases, let’s default to doing that work manually for now.

Details on the output files are below:

deleted-products-{date}-{version}.csv:

- one row for each SKU that is in the Shopify export CSV that does not exist in the AccountMate CSV (meaning, previously imported items that are no longer sold)
- I’ll use this file to manually mark products/variants as “inactive” in shopify
- volume should be low enough to handle this manually for now - in the future, i may need to automate

updated-products-{date}-{version}.csv

- one row for each item that exists in both files
- format should identically match that of the Shopify export CSV… this will allow me to directly input these items and update the existing products/variants with any updated data from the accountmate csv
- for existing products, we’ll only want to allow for updating a handful of fields if they differ between the two files, since Shopify is the system of record for certain things and shouldn’t be over-ridden… so, we’ll want some configurable list of allowed “updated” columns, as well as a per-field configurable mapping mechanism

new-products-{date}-{version}.csv

- one row for each SKU that is in the AccountMate export CSV that does not exist in the Shopify export CSV (meaning, Shopify previously imported items that are no longer sold)
- format should identically match that of the Shopify export CSV… this will allow me to directly input these items into Shopify
- one gotcha: AccountMate doesn’t support the concept of products/variants, but our Shopify catalog DOES use products/variants… so, some of the AccountMate products will need to map to Shopify under existing products as variants, some will need to be created as new variants, some will need to be created as new products… like updates, having a configurable mapping layer and logic layer for determining the product/variant mapping will be key

# approach

let’s first ideate on best approaches. please ask clarifying questions, and we’ll brainstorm ideas. then, we can begin implementing.
