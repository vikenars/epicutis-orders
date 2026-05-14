import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Package, ExternalLink, Moon, Sun, ChevronRight, Mic, MicOff, LogOut } from "lucide-react";

interface LineItem {
  title: string;
  sku: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  itemEstDelivery: string | null;
  itemFulfillmentStatus: string;
}

interface Order {
  orderName: string;
  date: string;
  channel: string;
  customerName: string;
  shipTo: string;
  items: LineItem[];
  subtotal: string;
  shipping: string;
  total: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  estDelivery: string;
  invoiceNumber: string;
  noteCustomer: string;
  orderType: string;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  let cls = "status-default";
  if (normalized === "fulfilled") cls = "status-fulfilled";
  else if (normalized === "in progress") cls = "status-in-progress";
  else if (normalized === "unfulfilled") cls = "status-unfulfilled";

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  const toggle = () => {
    const newDark = !dark;
    setDark(newDark);
    document.documentElement.classList.toggle("dark", newDark);
  };

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      data-testid="button-theme-toggle"
      className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

const COLS = 15; // total columns: Shopify Order #, Zoho Inv #, Date, Channel, Ship To, Items, Subtotal, Total, Fulfillment, Tracking #, Est. Delivery, Note Customer, Order Type (13 data cols + expand in first col)

function OrderRow({ order, idx }: { order: Order; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasItems = order.items && order.items.length > 0;

  return (
    <>
      {/* Main order row */}
      <tr
        data-testid={`row-order-${idx}`}
        className={`border-b border-border/50 transition-colors ${expanded ? "bg-secondary/20" : "hover:bg-secondary/30"}`}
      >
        {/* Expand toggle + order name */}
        <td className="px-3 py-3 whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {hasItems ? (
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? "Collapse items" : "Expand items"}
                data-testid={`button-expand-${idx}`}
                className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
              >
                <ChevronRight
                  size={13}
                  className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                />
              </button>
            ) : (
              <span className="w-5 flex-shrink-0" />
            )}
            <span className="font-mono text-xs font-semibold text-primary">
              {order.orderName}
            </span>
          </div>
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-xs font-mono">
          {order.invoiceNumber !== "—" ? order.invoiceNumber : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-xs">{order.date}</td>
        <td className="px-3 py-3 whitespace-nowrap text-xs">{order.channel}</td>
        <td className="px-3 py-3 whitespace-nowrap text-xs font-medium">
          {order.customerName !== "—" ? order.customerName : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-3 py-3 text-xs max-w-[180px]">
          <div className="whitespace-pre-line leading-snug">{order.shipTo}</div>
        </td>
        {/* Items summary — click to expand */}
        <td
          className="px-3 py-3 text-xs text-muted-foreground cursor-pointer select-none"
          onClick={() => hasItems && setExpanded((v) => !v)}
          title={expanded ? "Click to collapse" : "Click to expand items"}
        >
          {hasItems
            ? `${order.items.length} item${order.items.length !== 1 ? "s" : ""}`
            : "—"}
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-xs tabular-nums">{order.subtotal}</td>
        <td className="px-3 py-3 whitespace-nowrap text-xs tabular-nums font-semibold">{order.total}</td>
        <td className="px-3 py-3 whitespace-nowrap">
          <StatusBadge status={order.fulfillmentStatus} />
        </td>
        <td className="px-3 py-3 text-xs">
          {(() => {
            // Derive all unique tracking numbers from line items
            const seen = new Map<string, string>();
            for (const item of order.items) {
              if (item.trackingNumber && item.trackingUrl && !seen.has(item.trackingNumber)) {
                seen.set(item.trackingNumber, item.trackingUrl);
              }
            }
            // Fall back to order-level tracking if items have none
            if (seen.size === 0 && order.trackingNumber && order.trackingUrl) {
              seen.set(order.trackingNumber, order.trackingUrl);
            }
            if (seen.size === 0) return <span className="text-muted-foreground">—</span>;
            return (
              <div className="flex flex-col gap-0.5">
                {[...seen.entries()].map(([num, url]) => (
                  <a
                    key={num}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline font-mono whitespace-nowrap"
                  >
                    {num}
                    <ExternalLink size={11} />
                  </a>
                ))}
              </div>
            );
          })()}
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-xs text-muted-foreground">{order.estDelivery}</td>
        <td className="px-3 py-3 text-xs max-w-[180px]">
          {order.noteCustomer !== "—" ? order.noteCustomer : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-xs">
          {order.orderType !== "—" ? (
            <Badge variant="outline" className="text-xs font-normal">{order.orderType}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      </tr>

      {/* Expanded item rows */}
      {expanded && hasItems && order.items.map((item, itemIdx) => {
        const isInProgress = !item.trackingNumber || item.itemFulfillmentStatus === "unfulfilled";
        return (
          <tr
            key={`${order.orderName}-item-${itemIdx}`}
            data-testid={`row-item-${idx}-${itemIdx}`}
            className="border-b border-border/30 bg-secondary/10"
          >
            {/* Indent under order name — SKU */}
            <td className="pl-10 pr-3 py-2 whitespace-nowrap">
              <span className="text-xs text-muted-foreground font-mono">{item.sku}</span>
            </td>
            {/* Title spans Zoho Inv # + Date + Channel + Customer + Ship To */}
            <td colSpan={5} className="px-3 py-2 text-xs text-foreground">
              {item.title}
            </td>
            {/* Items col: qty × unit price */}
            <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
              {item.quantity} × {item.unitPrice}
            </td>
            {/* Subtotal col: line total */}
            <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
              {item.lineTotal}
            </td>
            {/* Total col: empty */}
            <td />
            {/* Fulfillment col: empty */}
            <td />
            {/* Tracking # col: per-item tracking or In Progress */}
            <td className="px-3 py-2 whitespace-nowrap text-xs">
              {isInProgress ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium status-in-progress">
                  In Progress
                </span>
              ) : (
                <a
                  href={item.trackingUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline font-mono"
                >
                  {item.trackingNumber}
                  <ExternalLink size={11} />
                </a>
              )}
            </td>
            {/* Est. Delivery col: per-item delivery */}
            <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
              {item.itemEstDelivery || "—"}
            </td>
            {/* Remaining cols (Note Customer, Order Type) empty */}
            <td colSpan={2} />
          </tr>
        );
      })}
    </>
  );
}

interface OrderSearchProps {
  user?: { email: string; label: string; role?: "admin" | "rsd" | "ae" } | null;
  onLogout?: () => void;
}

function roleLabel(role?: string): string | null {
  if (!role) return null;
  if (role === "ae") return "AE — your orders only";
  if (role === "rsd") return "RSD — all orders";
  if (role === "admin") return "Admin — all orders";
  return null;
}

export default function OrderSearch({ user, onLogout }: OrderSearchProps = {}) {
  const [inputValue, setInputValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechSupported(!!SpeechRecognition);
  }, []);

  const handleSearch = useCallback((q?: string) => {
    const val = q ?? inputValue;
    setSearchQuery(val);
    setHasSearched(true);
  }, [inputValue]);

  const toggleMic = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMicError("Speech recognition not supported in this browser.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    setMicError(null);

    // Request mic permission explicitly first
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(() => {
        const recognition = new SpeechRecognition();
        recognition.lang = "en-US";
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.continuous = false;
        recognitionRef.current = recognition;

        recognition.onstart = () => setIsListening(true);
        recognition.onend = () => setIsListening(false);
        recognition.onerror = (event: any) => {
          setIsListening(false);
          if (event.error === "not-allowed") {
            setMicError("Microphone access denied. Allow mic in Chrome's address bar.");
          } else if (event.error === "no-speech") {
            setMicError("No speech detected. Try again.");
          } else {
            setMicError(`Error: ${event.error}`);
          }
        };

        recognition.onresult = (event: any) => {
          const transcript = event.results[0][0].transcript.trim();
          const normalized = transcript
            .replace(/\b(epi)\s+(\d+)/gi, "EPI$2")
            .replace(/\b(inv(oice)?[-\s]*)(\d+)/gi, "$3")
            .replace(/\bnumber\b/gi, "#");
          setInputValue(normalized);
          handleSearch(normalized);
        };

        recognition.start();
      })
      .catch(() => {
        setMicError("Microphone access denied. Click the lock icon in Chrome's address bar to allow it.");
      });
  }, [isListening, handleSearch]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ["/api/orders/search", searchQuery],
    queryFn: async () => {
      try {
        const r = await apiRequest("GET", `/api/orders/search?q=${encodeURIComponent(searchQuery)}`);
        return await r.json();
      } catch (err: any) {
        if (typeof err?.message === "string" && err.message.startsWith("401")) {
          // Session expired — punt back to the login gate.
          onLogout?.();
        }
        throw err;
      }
    },
    enabled: hasSearched,
    staleTime: 30_000,
  });

  const orders: Order[] = data?.orders || [];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg aria-label="Epicutis" viewBox="0 0 32 32" width="32" height="32" fill="none" className="text-primary">
              <rect x="2" y="2" width="28" height="28" rx="6" stroke="currentColor" strokeWidth="2" />
              <path d="M8 16h16M16 8v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="16" cy="16" r="4" fill="currentColor" opacity="0.2" />
            </svg>
            <div>
              <h1 className="text-lg font-bold tracking-tight leading-none" style={{ fontFamily: "var(--font-display)" }}>
                Epicutis Orders
              </h1>
              <p className="text-xs text-muted-foreground">Order search &amp; lookup</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {user && (
              <div className="hidden sm:flex flex-col items-end leading-tight">
                <span className="text-xs text-muted-foreground" data-testid="text-user-email">
                  {user.email}
                </span>
                {roleLabel(user.role) && (
                  <span
                    className="text-[10px] uppercase tracking-wider text-muted-foreground/80"
                    data-testid="text-user-role"
                  >
                    {roleLabel(user.role)}
                  </span>
                )}
              </div>
            )}
            <ThemeToggle />
            {onLogout && (
              <button
                onClick={onLogout}
                aria-label="Sign out"
                title="Sign out"
                data-testid="button-logout"
                className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <LogOut size={18} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Search bar */}
      <div className="bg-card border-b border-border">
        <div className="max-w-screen-2xl mx-auto px-6 py-5">
          <div className="flex flex-col gap-2 max-w-2xl">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                ref={inputRef}
                data-testid="input-search"
                placeholder="Search by order #, customer name, city, invoice, SKU…"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className={`pl-9 bg-background pr-10 ${isListening ? "ring-2 ring-red-400" : ""}`}
              />
              {/* Mic button inside input */}
              {speechSupported && (
                <button
                  onClick={toggleMic}
                  title={isListening ? "Stop listening" : "Search by voice"}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full transition-colors ${
                    isListening
                      ? "text-red-500 animate-pulse"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {isListening ? <MicOff size={15} /> : <Mic size={15} />}
                </button>
              )}
            </div>
            <Button
              data-testid="button-search"
              onClick={() => handleSearch()}
              disabled={isFetching}
              className="px-6"
            >
              {isFetching ? "Searching…" : "Search"}
            </Button>
          </div>
          {/* Listening indicator */}
          {isListening && (
            <div className="flex items-center gap-2 text-xs text-red-500">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              Listening… speak your order number or customer name
            </div>
          )}
          {/* Mic error */}
          {micError && !isListening && (
            <div className="text-xs text-destructive">{micError}</div>
          )}
          </div>
          {hasSearched && !isFetching && (
            <p className="text-xs text-muted-foreground mt-2">
              {orders.length === 0
                ? user?.role === "ae"
                  ? "No orders found for your accounts. Results are filtered to orders where you are the salesperson."
                  : "No orders found"
                : `${orders.length} order${orders.length !== 1 ? "s" : ""} found${searchQuery ? ` for "${searchQuery}"` : ""}${user?.role === "ae" ? " (filtered to your accounts)" : ""}`}
            </p>
          )}
        </div>
      </div>

      {/* Results */}
      <main className="max-w-screen-2xl mx-auto px-6 py-6">
        {isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 text-destructive px-4 py-3 text-sm">
            Failed to fetch orders. Please try again.
          </div>
        )}

        {!hasSearched && !isFetching && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center">
              <Package size={24} className="text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-foreground">Search Epicutis Orders</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Enter an order number, customer name, invoice, city, or leave blank to see recent orders.
              </p>
            </div>
          </div>
        )}

        {isFetching && (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}

        {!isFetching && hasSearched && orders.length > 0 && (
          <div className="table-scroll rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full text-sm min-w-[1400px]">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  {[
                    "Shopify Order #", "Zoho Inv #", "Order Date", "Channel", "Customer", "Ship To", "Items",
                    "Subtotal", "Total",
                    "Fulfillment", "Tracking #", "Est. Delivery",
                    "Note Customer", "Order Type",
                  ].map((h) => (
                    <th
                      key={h}
                      className="px-3 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((order, idx) => (
                  <OrderRow key={order.orderName} order={order} idx={idx} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
