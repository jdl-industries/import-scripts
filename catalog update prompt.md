let's write a script that updates products in a shopify store using the admin api according to an input file. the file is an export from an ERP system that is sent daily in order to update inventory and prices in shopify (in case they've changed in the ERP system unknown to shopify). the file is expected to have a header row with known columns. let's write the script in javascript so it can be executed via node.js.

Here is the process

for each line:
save the unprocessed value - it will need to be written to an output file
extra the values from the columns "SKU", "Regular price", "Fixed Tiered Prices"
map the "fixed tiered prices" value from it's source format
source is a comma-separate set of tuples consisting of quantity break level and quantity price (eg "1:131.50,9:100.25,33:86.00")
output should be a json object with the following shape (example data matches the above) - essentially add an entry for each quantity break to the "discounts" property array, 1 should always have the value null and name should always be "All customers", and also add the quantity break level to the quantityBreaks array:
{
"discounts":
[
{"1":null, "9":"100.25", "33":"86.00","name":"All customers"}
],
"quantityBreaks":[1,9,33],
"discountType\":\price"
}
query using the shopify Admin API to look up the product where "sku" equals the "SKU" column for the CSV row
if not found - output the csv row to a file "missing_products.csv" (ensure the header row is added atop this file)
if the product IS found, run a mutation using the admin API on this product:
set the price for the default variant to the "Regular price" value
set the metafield (namespace: "app--339692257281", key: "tiered_pricing") on the default variant to the JSON.stringified value fo the JSON object created above
once the product has been written, output the row to a new csv file "updated_products.csv"
if an error occurs during write, output the row to a new csv file "failed_updates.csv"

the credentials for the admin API calls will come from an env var SHOPIFY_TOKEN
