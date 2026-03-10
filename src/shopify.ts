import type { ShopifyProduct } from './types.js';

interface ShopifyConfig {
  storeDomain: string;
  accessToken: string;
}

interface ProductInput {
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  handle: string;
  seo: {
    title: string;
    description: string;
  };
  metafields: MetafieldInput[];
  variants: VariantInput[];
}

interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

interface VariantInput {
  sku: string;
  price: string;
  weight: number;
  weightUnit: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ProductCreateResponse {
  productCreate: {
    product: {
      id: string;
      handle: string;
    } | null;
    userErrors: Array<{
      field: string[];
      message: string;
    }>;
  };
}

/**
 * Shopify Admin API client
 */
export class ShopifyClient {
  private config: ShopifyConfig;
  private apiVersion = '2024-01';

  constructor() {
    const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!storeDomain || !accessToken) {
      throw new Error(
        'SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN environment variables are required'
      );
    }

    this.config = { storeDomain, accessToken };
  }

  /**
   * Create or update a product in Shopify
   */
  async upsertProduct(product: ShopifyProduct): Promise<string> {
    // First, try to find existing product by SKU
    const existingProductId = await this.findProductBySku(product.sku);

    if (existingProductId) {
      await this.updateProduct(existingProductId, product);
      return existingProductId;
    } else {
      return await this.createProduct(product);
    }
  }

  /**
   * Find a product by SKU
   */
  private async findProductBySku(sku: string): Promise<string | null> {
    const query = `
      query findProductBySku($query: String!) {
        products(first: 1, query: $query) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const response = await this.graphql<{
      products: { edges: Array<{ node: { id: string } }> };
    }>(query, { query: `sku:${sku}` });

    if (response.data?.products.edges.length) {
      return response.data.products.edges[0].node.id;
    }

    return null;
  }

  /**
   * Create a new product
   */
  private async createProduct(product: ShopifyProduct): Promise<string> {
    const mutation = `
      mutation productCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id
            handle
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = this.buildProductInput(product);
    const response = await this.graphql<ProductCreateResponse>(mutation, { input });

    if (response.data?.productCreate.userErrors.length) {
      const errors = response.data.productCreate.userErrors
        .map((e) => `${e.field.join('.')}: ${e.message}`)
        .join(', ');
      throw new Error(`Failed to create product: ${errors}`);
    }

    if (!response.data?.productCreate.product) {
      throw new Error('Failed to create product: no product returned');
    }

    return response.data.productCreate.product.id;
  }

  /**
   * Update an existing product
   */
  private async updateProduct(
    productId: string,
    product: ShopifyProduct
  ): Promise<void> {
    const mutation = `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = {
      id: productId,
      ...this.buildProductInput(product),
    };

    const response = await this.graphql<{
      productUpdate: {
        product: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(mutation, { input });

    if (response.data?.productUpdate.userErrors.length) {
      const errors = response.data.productUpdate.userErrors
        .map((e) => `${e.field.join('.')}: ${e.message}`)
        .join(', ');
      throw new Error(`Failed to update product: ${errors}`);
    }
  }

  /**
   * Build product input for Shopify GraphQL API
   */
  private buildProductInput(product: ShopifyProduct): ProductInput {
    // Extract manufacturer from title (first word)
    const vendor = product.title.split(' ')[0] || 'Unknown';

    // Build tags from category flags
    const tags: string[] = [];
    if (product.aviation === 'Yes') tags.push('Aviation');
    if (product.marine === 'Yes') tags.push('Marine');
    if (product.industrial === 'Yes') tags.push('Industrial');
    if (product.isHazmat === 'true') tags.push('Hazmat');

    // Build metafields
    const metafields: MetafieldInput[] = [];

    if (product.manufacturerPartNumber) {
      metafields.push({
        namespace: 'custom',
        key: 'manufacturer_part_number',
        value: product.manufacturerPartNumber,
        type: 'single_line_text_field',
      });
    }

    if (product.qpl) {
      metafields.push({
        namespace: 'custom',
        key: 'qpl',
        value: product.qpl,
        type: 'single_line_text_field',
      });
    }

    if (product.nsn) {
      metafields.push({
        namespace: 'custom',
        key: 'nsn',
        value: product.nsn,
        type: 'single_line_text_field',
      });
    }

    if (product.militarySpecification) {
      metafields.push({
        namespace: 'custom',
        key: 'military_specification',
        value: product.militarySpecification,
        type: 'single_line_text_field',
      });
    }

    if (product.complianceAndCertifications) {
      metafields.push({
        namespace: 'custom',
        key: 'compliance_certifications',
        value: product.complianceAndCertifications,
        type: 'single_line_text_field',
      });
    }

    if (product.leadTime !== '0') {
      metafields.push({
        namespace: 'custom',
        key: 'lead_time_days',
        value: product.leadTime,
        type: 'number_integer',
      });
    }

    metafields.push({
      namespace: 'custom',
      key: 'is_hazmat',
      value: product.isHazmat,
      type: 'boolean',
    });

    return {
      title: product.title,
      descriptionHtml: product.description,
      vendor,
      productType: product.category,
      tags,
      handle: product.urlHandle,
      seo: {
        title: product.pageTitle,
        description: product.metaDescription,
      },
      metafields,
      variants: [
        {
          sku: product.sku,
          price: product.regularPrice || '0',
          weight: parseFloat(product.weight) || 0,
          weightUnit: 'POUNDS',
        },
      ],
    };
  }

  /**
   * Execute a GraphQL query against the Shopify Admin API
   */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<GraphQLResponse<T>> {
    const url = `https://${this.config.storeDomain}/admin/api/${this.apiVersion}/graphql.json`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.config.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(
        `Shopify API error: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  /**
   * Import multiple products with rate limiting
   */
  async importProducts(
    products: ShopifyProduct[],
    onProgress?: (current: number, total: number, sku: string) => void
  ): Promise<{ success: number; errors: Array<{ sku: string; error: string }> }> {
    const results = {
      success: 0,
      errors: [] as Array<{ sku: string; error: string }>,
    };

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      if (onProgress) {
        onProgress(i + 1, products.length, product.sku);
      }

      try {
        await this.upsertProduct(product);
        results.success++;
      } catch (error) {
        results.errors.push({
          sku: product.sku,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Rate limiting: Shopify allows 2 requests per second for REST,
      // but GraphQL has different limits. Adding a small delay to be safe.
      await this.delay(250);
    }

    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
