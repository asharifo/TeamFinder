# To-Do:

# Realtime + React Query Architecture Plan

## 1. Target Architecture

### Frontend
- Use **TanStack React Query** for all server-state reads and mutations.
- React Query cache becomes the **single source of truth** for server data.
- No ad-hoc fetch + local state duplication.

### Backend
- Keep **Kafka** for internal domain events.
- Add a **realtime fanout layer** (Socket.IO) to push authorized domain events to clients.

### Realtime Flow
Kafka → Backend Consumer → Socket.IO Fanout → Client → React Query cache update

Frontend updates happen via:
- `queryClient.setQueryData()` for precise patches
- `queryClient.invalidateQueries()` for broader revalidation

---

## 2. Phase 1: React Query Foundation

### Install

```bash
npm install @tanstack/react-query
```

### Setup QueryClient

```jsx
// main.jsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

root.render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
```

---

## 3. Replace Manual Fetches

### Before

```jsx
useEffect(() => {
  fetch("/api/classes")
    .then(res => res.json())
    .then(setClasses);
}, []);
```

### After

```jsx
import { useQuery } from "@tanstack/react-query";

const { data: classes = [], isLoading } = useQuery({
  queryKey: ["classes"],
  queryFn: async () => {
    const res = await fetch("/api/classes");
    if (!res.ok) throw new Error("Failed");
    return res.json();
  },
});
```

---

## 4. Mutations with Automatic Invalidation

```jsx
import { useMutation, useQueryClient } from "@tanstack/react-query";

const queryClient = useQueryClient();

const enrollMutation = useMutation({
  mutationFn: async (classId) => {
    const res = await fetch(`/api/classes/${classId}/enroll`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("Enroll failed");
    return res.json();
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["classes"] });
    queryClient.invalidateQueries({ queryKey: ["recommendations"] });
  },
});
```

---

## 5. Phase 2: Realtime Socket Layer

### Backend
- Kafka consumers listen to domain events:
  - `profile.updated`
  - `class.enrollment.created`
  - `group.member.added`
- On event:
  - Validate affected user(s)
  - Emit via Socket.IO to correct rooms

Example:

```js
io.to(`user:${userId}`).emit("class.enrollment.created", payload);
```

---

## 6. Frontend Realtime Listener

Create one global socket connection.

```jsx
import { io } from "socket.io-client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

const socket = io("http://localhost:8080", {
  withCredentials: true,
});

export function RealtimeBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    socket.on("class.enrollment.created", (payload) => {
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    });

    socket.on("profile.updated", (payload) => {
      queryClient.setQueryData(["profile", payload.userId], payload);
    });

    return () => {
      socket.off("class.enrollment.created");
      socket.off("profile.updated");
    };
  }, [queryClient]);

  return null;
}
```

Mount once near root:

```jsx
<QueryClientProvider client={queryClient}>
  <RealtimeBridge />
  <App />
</QueryClientProvider>
```

---

## 7. Cache Strategy Rules

### Use `setQueryData`
When:
- You know the exact updated object
- The patch is small
- You want to avoid a refetch

### Use `invalidateQueries`
When:
- Server computes derived fields
- Multiple related lists are affected
- You prefer correctness over micro-optimization

---

## 8. Final Architecture Summary

- React Query = server-state layer
- Kafka = internal reliability and async boundaries
- Socket.IO = client fanout
- No polling
- No duplicated local server state
- All updates flow through cache

Single source of truth: React Query cache

# Add student profile view functionality 
# Import Python recommender system 
# Add friend functionality through profile view and student list view in classes
# Possibly restrict chatting to friends
# Possible add message functionality through profile and student list view in classes
# Employ more robust pagination with page/offset/cursor at the relevant locations
