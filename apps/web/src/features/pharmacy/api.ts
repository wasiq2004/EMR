'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdjustStock,
  ClarificationRow,
  DispenseDetail,
  DispenseQueueRow,
  FillLine,
  GoodsReceiptRow,
  OpeningBalance,
  PharmacyAlerts,
  PharmacyProduct,
  PharmacyReport,
  PurchaseOrder,
  ReceiveGoods,
  RecordSale,
  ReturnSale,
  SaleRow,
  SaveProduct,
  SavePurchaseOrder,
  SaveSupplier,
  StockBatch,
  StockMovementRow,
  Supplier,
} from '@emr/contracts';
import { api } from '@/lib/api-client';

/**
 * The pharmacy data layer.
 *
 * One invalidation helper rather than a hand-written list per mutation, because
 * almost everything at a counter touches stock: dispensing, selling, receiving and
 * adjusting all change a quantity, and any of them leaving a stale batch list on
 * screen would have a pharmacist picking from a batch that is already empty.
 *
 * The queue is polled as well as invalidated. SSE delivers the change when a
 * doctor finalises a prescription elsewhere in the building, and a thirty-second
 * poll is the floor under that — a counter must not depend on a socket staying up.
 */

export const pk = {
  queue: (status?: string) => ['pharmacy', 'queue', status ?? 'open'] as const,
  dispense: (id: string) => ['pharmacy', 'dispense', id] as const,
  clarifications: (scope: string) => ['pharmacy', 'clarifications', scope] as const,
  alerts: () => ['pharmacy', 'alerts'] as const,
  stock: (productId?: string, search?: string) =>
    ['pharmacy', 'stock', productId ?? '', search ?? ''] as const,
  movements: (batchId?: string, productId?: string) =>
    ['pharmacy', 'movements', batchId ?? '', productId ?? ''] as const,
  products: (search?: string, lowOnly?: boolean) =>
    ['pharmacy', 'products', search ?? '', lowOnly ?? false] as const,
  product: (id: string) => ['pharmacy', 'product', id] as const,
  unstocked: (search?: string) => ['pharmacy', 'unstocked', search ?? ''] as const,
  suppliers: (includeInactive?: boolean) =>
    ['pharmacy', 'suppliers', includeInactive ?? false] as const,
  orders: (status?: string) => ['pharmacy', 'orders', status ?? 'all'] as const,
  order: (id: string) => ['pharmacy', 'order', id] as const,
  receipts: () => ['pharmacy', 'receipts'] as const,
  sales: () => ['pharmacy', 'sales'] as const,
  sale: (id: string) => ['pharmacy', 'sale', id] as const,
  quote: (id: string) => ['pharmacy', 'quote', id] as const,
  report: (days: number) => ['pharmacy', 'report', days] as const,
};

/** Everything a stock change could be showing stale. */
function useInvalidatePharmacy() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
    // The sidebar badge counts live outside this namespace.
    void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
  };
}

/* ---- The queue ----------------------------------------------------------- */

export function usePharmacyQueue(status?: string, includeFinished = false) {
  return useQuery({
    queryKey: pk.queue(includeFinished ? 'all' : status),
    queryFn: () =>
      api.get<{ items: DispenseQueueRow[] }>('/pharmacy/queue', {
        query: {
          ...(status ? { status } : {}),
          ...(includeFinished ? { includeFinished: 'true' } : {}),
        },
      }),
    select: (data) => data.items,
    // A counter is a live surface. Thirty seconds is the floor under SSE.
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useDispense(id: string) {
  return useQuery({
    queryKey: pk.dispense(id),
    queryFn: () => api.get<DispenseDetail>(`/pharmacy/queue/${id}`),
    enabled: Boolean(id),
    staleTime: 5_000,
  });
}

export function useStartDispense() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (id: string) => api.post(`/pharmacy/queue/${id}/start`, {}),
    onSuccess: invalidate,
  });
}

/**
 * Fills one prescription line.
 *
 * NO IDEMPOTENCY KEY, and that is correct rather than an omission.
 *
 * This comment used to say the opposite — "a double-submitted fill would move
 * stock twice, and the second movement would be indistinguishable from a genuine
 * correction" — and passed a key as an `Idempotency-Key` header, which nothing
 * on the server reads. Both halves were wrong. Reading
 * `DispensingService.fillLine`: it calls `reverseExisting` first, returning the
 * line's previous quantity to stock, and only then issues the new amount. It is
 * a SET, not an ADD. Submitting the same fill twice reverses and re-issues, and
 * the net stock is right.
 *
 * What a double-submit does cost is two extra rows in the movement ledger. That
 * is noise in an append-only audit trail rather than wrong stock, and it is the
 * honest price of a correction path that works.
 */
export function useFillLine() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({ lineId, input }: { lineId: string; input: FillLine }) =>
      api.post(`/pharmacy/lines/${lineId}/fill`, input),
    onSuccess: invalidate,
  });
}

export function useCompleteDispense() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (id: string) => api.post(`/pharmacy/queue/${id}/complete`, {}),
    onSuccess: invalidate,
  });
}

export function useReopenDispense() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (id: string) => api.post(`/pharmacy/queue/${id}/reopen`, {}),
    onSuccess: invalidate,
  });
}

export function useCancelDispense() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/pharmacy/queue/${id}/cancel`, { reason }),
    onSuccess: invalidate,
  });
}

/* ---- Clarifications ------------------------------------------------------ */

export function useClarifications(options: { status?: string; mine?: boolean } = {}) {
  return useQuery({
    queryKey: pk.clarifications(options.mine ? 'mine' : (options.status ?? 'all')),
    queryFn: () =>
      api.get<{ items: ClarificationRow[] }>('/pharmacy/clarifications', {
        query: {
          ...(options.status ? { status: options.status } : {}),
          ...(options.mine ? { mine: 'true' } : {}),
        },
      }),
    select: (data) => data.items,
    refetchInterval: 60_000,
  });
}

export function useRaiseClarification() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({
      dispenseId,
      medicationRequestId,
      question,
    }: {
      dispenseId: string;
      medicationRequestId: string;
      question: string;
    }) =>
      api.post(`/pharmacy/queue/${dispenseId}/clarifications`, {
        medicationRequestId,
        question,
      }),
    onSuccess: invalidate,
  });
}

export function useAnswerClarification() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({
      id,
      answer,
      resolutionAction,
    }: {
      id: string;
      answer: string;
      resolutionAction: string;
    }) => api.post(`/pharmacy/clarifications/${id}/answer`, { answer, resolutionAction }),
    onSuccess: invalidate,
  });
}

export function useWithdrawClarification() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/pharmacy/clarifications/${id}/withdraw`, { reason }),
    onSuccess: invalidate,
  });
}

/* ---- Stock --------------------------------------------------------------- */

export function usePharmacyAlerts() {
  return useQuery({
    queryKey: pk.alerts(),
    queryFn: () => api.get<PharmacyAlerts>('/pharmacy/alerts'),
    refetchInterval: 120_000,
  });
}

export function useStockBatches(options: { productId?: string; search?: string; includeEmpty?: boolean } = {}) {
  return useQuery({
    queryKey: pk.stock(options.productId, options.search),
    queryFn: () =>
      api.get<{ items: StockBatch[] }>('/pharmacy/stock', {
        query: {
          ...(options.productId ? { productId: options.productId } : {}),
          ...(options.search ? { search: options.search } : {}),
          ...(options.includeEmpty ? { includeEmpty: 'true' } : {}),
        },
      }),
    select: (data) => data.items,
  });
}

export function useStockMovements(options: { stockBatchId?: string; productId?: string }) {
  return useQuery({
    queryKey: pk.movements(options.stockBatchId, options.productId),
    queryFn: () =>
      api.get<{ items: StockMovementRow[] }>('/pharmacy/stock/movements', {
        query: {
          ...(options.stockBatchId ? { stockBatchId: options.stockBatchId } : {}),
          ...(options.productId ? { productId: options.productId } : {}),
        },
      }),
    select: (data) => data.items,
    enabled: Boolean(options.stockBatchId ?? options.productId),
  });
}

export function useAdjustStock() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: AdjustStock) => api.post('/pharmacy/stock/adjust', input),
    onSuccess: invalidate,
  });
}

export function useOpeningBalance() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: OpeningBalance) => api.post('/pharmacy/stock/opening-balance', input),
    onSuccess: invalidate,
  });
}

/* ---- Products and suppliers --------------------------------------------- */

export function useProducts(options: { search?: string; lowStockOnly?: boolean; includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: pk.products(options.search, options.lowStockOnly),
    queryFn: () =>
      api.get<{ items: PharmacyProduct[] }>('/pharmacy/products', {
        query: {
          ...(options.search ? { search: options.search } : {}),
          ...(options.lowStockOnly ? { lowStockOnly: 'true' } : {}),
          ...(options.includeInactive ? { includeInactive: 'true' } : {}),
        },
      }),
    select: (data) => data.items,
  });
}

export function useSaveProduct() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: SaveProduct & { id?: string }) => api.post('/pharmacy/products', input),
    onSuccess: invalidate,
  });
}

export function useRetireProduct() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (id: string) => api.post(`/pharmacy/products/${id}/retire`, {}),
    onSuccess: invalidate,
  });
}

/** Drug-catalogue entries the pharmacy does not stock yet. */
export function useUnstockedCatalogue(search: string, enabled: boolean) {
  return useQuery({
    queryKey: pk.unstocked(search),
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          brandName: string | null;
          moleculeName: string;
          strength: string | null;
          dosageForm: string | null;
          manufacturer: string | null;
          drugSchedule: string | null;
        }[];
      }>('/pharmacy/catalogue/unstocked', { query: search ? { search } : {} }),
    select: (data) => data.items,
    enabled,
  });
}

export function useSuppliers(includeInactive = false) {
  return useQuery({
    queryKey: pk.suppliers(includeInactive),
    queryFn: () =>
      api.get<{ items: Supplier[] }>('/pharmacy/suppliers', {
        query: includeInactive ? { includeInactive: 'true' } : {},
      }),
    select: (data) => data.items,
  });
}

export function useSaveSupplier() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: SaveSupplier & { id?: string }) => api.post('/pharmacy/suppliers', input),
    onSuccess: invalidate,
  });
}

/* ---- Purchasing --------------------------------------------------------- */

export function usePurchaseOrders(status?: string) {
  return useQuery({
    queryKey: pk.orders(status),
    queryFn: () =>
      api.get<{ items: (PurchaseOrder & { lineCount: number })[] }>('/pharmacy/purchase-orders', {
        query: status ? { status } : {},
      }),
    select: (data) => data.items,
  });
}

export function usePurchaseOrder(id: string) {
  return useQuery({
    queryKey: pk.order(id),
    queryFn: () => api.get<PurchaseOrder>(`/pharmacy/purchase-orders/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreatePurchaseOrder() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: SavePurchaseOrder) => api.post('/pharmacy/purchase-orders', input),
    onSuccess: invalidate,
  });
}

export function useOrderAction() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'submit' | 'approve' | 'cancel';
      reason?: string;
    }) => api.post(`/pharmacy/purchase-orders/${id}/${action}`, reason ? { reason } : {}),
    onSuccess: invalidate,
  });
}

export function useReceipts() {
  return useQuery({
    queryKey: pk.receipts(),
    queryFn: () => api.get<{ items: GoodsReceiptRow[] }>('/pharmacy/receipts'),
    select: (data) => data.items,
  });
}

/**
 * Records a delivery.
 *
 * THE KEY GOES IN THE BODY. It used to be passed as an `Idempotency-Key`
 * header, which nothing on the server reads — so a receipt submitted twice
 * created stock twice, and the shortfall surfaced at the next count with no way
 * to tell which receipt was the phantom. `ReceiveGoods` requires it now and a
 * partial unique index enforces it.
 *
 * The caller supplies the key and holds it stable across retries; minting one
 * inside `mutationFn` would produce a fresh key per attempt, which is not
 * idempotency at all.
 */
export function useReceiveGoods() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: ReceiveGoods) => api.post('/pharmacy/receipts', input),
    onSuccess: invalidate,
  });
}

export function useReturnToSupplier() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: { stockBatchId: string; quantity: number; reason: string }) =>
      api.post('/pharmacy/purchase-returns', input),
    onSuccess: invalidate,
  });
}

/* ---- Sales -------------------------------------------------------------- */

export function useSales() {
  return useQuery({
    queryKey: pk.sales(),
    queryFn: () => api.get<{ items: SaleRow[] }>('/pharmacy/sales'),
    select: (data) => data.items,
  });
}

export function useDispenseQuote(dispenseId: string, enabled: boolean) {
  return useQuery({
    queryKey: pk.quote(dispenseId),
    queryFn: () =>
      api.get<{
        lines: {
          productId: string;
          productName: string;
          stockBatchId: string;
          batchNumber: string;
          quantity: number;
          unitPricePaise: number;
          gstRateBps: number;
          discountPaise: number;
        }[];
        subtotalPaise: number;
        taxPaise: number;
        totalPaise: number;
      }>(`/pharmacy/queue/${dispenseId}/quote`),
    enabled: enabled && Boolean(dispenseId),
  });
}

/**
 * Takes money and removes stock.
 *
 * Same correction as `useReceiveGoods`: the key is a body field the server
 * actually reads, not a header it ignores. A double-tap at a counter used to
 * charge the customer twice and remove the stock twice.
 */
export function useRecordSale() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: (input: RecordSale) => api.post('/pharmacy/sales', input),
    onSuccess: invalidate,
  });
}

/**
 * One sale with its lines.
 *
 * The list gives totals and a line COUNT, which is enough to show the till and
 * not enough to take anything back: a return line has to name the batch the
 * goods came off, and nothing returned a batch id until `GET /pharmacy/sales/:id`
 * was added. That is why the return endpoint sat implemented and unreachable.
 */
export function useSale(id: string | null) {
  return useQuery({
    queryKey: pk.sale(id ?? 'none'),
    queryFn: () => api.get<SaleDetail>(`/pharmacy/sales/${id}`),
    enabled: Boolean(id),
  });
}

export interface SaleDetail {
  id: string;
  saleNumber: string;
  status: string;
  patientId: string | null;
  patientName: string | null;
  buyerName: string | null;
  totalPaise: number;
  paidPaise: number;
  paymentMethod: string | null;
  soldAt: string | null;
  soldByName: string | null;
  isReturn: boolean;
  returnOfSaleId: string | null;
  returnReason: string | null;
  lines: {
    id: string;
    productId: string;
    productName: string | null;
    packUnit: string | null;
    stockBatchId: string;
    batchNumber: string | null;
    expiryDate: string | null;
    quantity: number;
    unitPricePaise: number;
    gstRateBps: number;
    lineTotalPaise: number;
    alreadyReturned: number;
    /** Sold, net of returns already recorded. The server computes it. */
    returnableQuantity: number;
  }[];
}

/**
 * Takes goods back and puts the stock on the batch it came off.
 *
 * NOT A CORRECTION TO THE ORIGINAL SALE. The server writes a second sale with
 * negative lines pointing at the first, because the original transaction
 * happened and a till that can make a sale disappear cannot be reconciled
 * against a cash drawer.
 *
 * No idempotency key, and this is a deliberate difference from `useRecordSale`.
 * A duplicate return would put the stock back twice and refund twice, so it
 * matters — but the server already caps each product at what was sold net of
 * returns, which makes the second submission fail with "more than was sold"
 * rather than silently doubling. That is a correct refusal, not a race, so a key
 * would buy a tidier error message and nothing else.
 */
export function useReturnSale() {
  const invalidate = useInvalidatePharmacy();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReturnSale }) =>
      api.post<{ id: string; saleNumber: string; refundedPaise: number }>(
        `/pharmacy/sales/${id}/return`,
        input,
      ),
    onSuccess: invalidate,
  });
}

/* ---- Reporting ---------------------------------------------------------- */

export function usePharmacyReport(days: number) {
  return useQuery({
    queryKey: pk.report(days),
    queryFn: () => api.get<PharmacyReport>('/pharmacy/reports', { query: { days: String(days) } }),
    staleTime: 60_000,
  });
}
