import { useCallback, useRef } from "react";
import { FlatList, type ListRenderItem, type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet } from "react-native";

import type { Source } from "../state/machine";
import type { ChatMessage } from "../state/store";
import { MessageBubble } from "./MessageBubble";
import { StreamingBubble } from "./StreamingBubble";

interface Props {
  messages: ChatMessage[];
  onSourcePress: (source: Source) => void;
  onRetry: (question: string) => void;
}

const NEAR_BOTTOM_PX = 120;
const keyExtractor = (m: ChatMessage): string => m.id;

/**
 * Finished messages are the FlatList data (changes only when a message is added). The live
 * answer is the ListFooterComponent, so token flushes never touch the list data or its rows.
 */
export function ChatList({ messages, onSourcePress, onRetry }: Props) {
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const nearBottom = useRef(true);

  const renderItem = useCallback<ListRenderItem<ChatMessage>>(
    ({ item }) => <MessageBubble message={item} onSourcePress={onSourcePress} onRetry={onRetry} />,
    [onSourcePress, onRetry],
  );

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - NEAR_BOTTOM_PX;
  }, []);

  // Content grows as the footer streams: follow it only if the user hasn't scrolled up.
  const onContentSizeChange = useCallback(() => {
    if (nearBottom.current) listRef.current?.scrollToEnd({ animated: false });
  }, []);

  return (
    <FlatList
      ref={listRef}
      style={styles.list}
      contentContainerStyle={styles.content}
      data={messages}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListFooterComponent={StreamingBubble}
      removeClippedSubviews
      windowSize={7}
      initialNumToRender={10}
      maxToRenderPerBatch={8}
      onScroll={onScroll}
      scrollEventThrottle={100}
      onContentSizeChange={onContentSizeChange}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingVertical: 12 },
});
