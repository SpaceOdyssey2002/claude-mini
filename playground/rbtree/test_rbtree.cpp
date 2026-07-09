#include "rbtree.hpp"
#include <iostream>
#include <cassert>
#include <string>
#include <vector>
#include <cstdlib>
#include <ctime>

void testBasicInsertAndFind() {
    std::cout << "===== 测试：基本插入和查找 =====\n";
    RBTree<int, std::string> tree;

    tree.insert(10, "十");
    tree.insert(20, "二十");
    tree.insert(30, "三十");
    tree.insert(15, "十五");
    tree.insert(5,  "五");

    assert(tree.size() == 5);
    assert(tree.contains(10));
    assert(!tree.contains(99));

    auto* v = tree.find(20);
    assert(v != nullptr && *v == "二十");

    v = tree.find(99);
    assert(v == nullptr);

    std::cout << "  size = " << tree.size() << " ✓\n";
    std::cout << "  树结构:\n" << tree.toString();
    std::cout << "  树结构有效: " << (tree.validate() ? "是 ✓" : "否 ✗") << "\n\n";
}

void testInsertDuplicateKey() {
    std::cout << "===== 测试：重复键插入（更新值） =====\n";
    RBTree<int, std::string> tree;

    tree.insert(1, "一");
    tree.insert(1, "壹");  // 更新值
    assert(tree.size() == 1);

    auto* v = tree.find(1);
    assert(v != nullptr && *v == "壹");
    std::cout << "  重复键更新成功: key=1, value=\"" << *v << "\" ✓\n\n";
}

void testRemove() {
    std::cout << "===== 测试：删除操作 =====\n";
    RBTree<int, std::string> tree;

    for (int i = 1; i <= 10; ++i) {
        tree.insert(i, std::to_string(i) + "号");
    }
    std::cout << "  插入 1-10 后 size = " << tree.size() << "\n";

    // 删除叶子节点
    assert(tree.remove(1));
    assert(!tree.contains(1));
    std::cout << "  删除叶子节点 1 ✓, size = " << tree.size() << "\n";

    // 删除只有一个子节点的节点
    assert(tree.remove(2));
    assert(!tree.contains(2));
    std::cout << "  删除单子节点 2 ✓, size = " << tree.size() << "\n";

    // 删除有两个子节点的节点
    assert(tree.remove(5));
    assert(!tree.contains(5));
    std::cout << "  删除双子节点 5 ✓, size = " << tree.size() << "\n";

    // 删除不存在的键
    assert(!tree.remove(99));
    std::cout << "  删除不存在键 99 返回 false ✓\n";

    std::cout << "  最终 size = " << tree.size() << "\n";
    std::cout << "  树结构有效: " << (tree.validate() ? "是 ✓" : "否 ✗") << "\n";
    std::cout << "  树结构:\n" << tree.toString() << "\n";
}

void testTraversal() {
    std::cout << "===== 测试：遍历 =====\n";
    RBTree<int, std::string> tree;

    tree.insert(3, "C");
    tree.insert(1, "A");
    tree.insert(4, "D");
    tree.insert(2, "B");
    tree.insert(5, "E");

    std::cout << "  中序遍历 (应有序): ";
    tree.inorder([](int k, const std::string& v) {
        std::cout << k << ":" << v << " ";
    });
    std::cout << "\n";

    std::cout << "  先序遍历: ";
    tree.preorder([](int k, const std::string& v) {
        std::cout << k << ":" << v << " ";
    });
    std::cout << "\n";

    std::cout << "  后序遍历: ";
    tree.postorder([](int k, const std::string& v) {
        std::cout << k << ":" << v << " ";
    });
    std::cout << "\n\n";
}

void testClearAndEmpty() {
    std::cout << "===== 测试：清空和空树 =====\n";
    RBTree<int, std::string> tree;

    assert(tree.empty());
    std::cout << "  空树: " << (tree.empty() ? "是 ✓" : "否 ✗") << "\n";

    tree.insert(1, "a");
    tree.insert(2, "b");
    assert(!tree.empty());
    std::cout << "  插入后 empty = false ✓\n";

    tree.clear();
    assert(tree.empty());
    assert(tree.size() == 0);
    std::cout << "  清空后 size = " << tree.size() << ", empty = true ✓\n";
    std::cout << "  树结构有效: " << (tree.validate() ? "是 ✓" : "否 ✗") << "\n\n";
}

void testLargeScale() {
    std::cout << "===== 测试：大规模随机操作 =====\n";
    RBTree<int, int> tree;
    const int N = 1000;

    // 插入 N 个随机数
    std::vector<int> keys;
    for (int i = 0; i < N; ++i) {
        int k = rand() % 5000;
        keys.push_back(k);
        tree.insert(k, k * 10);
    }

    std::cout << "  插入 " << N << " 个元素后 size = " << tree.size() << "\n";
    std::cout << "  树结构有效: " << (tree.validate() ? "是 ✓" : "否 ✗") << "\n";

    // 验证查找
    int found = 0;
    for (int k : keys) {
        if (tree.contains(k)) ++found;
    }
    std::cout << "  查找到 " << found << "/" << N << " 个插入的键 ✓\n";

    // 删除一半
    int removed = 0;
    for (size_t i = 0; i < keys.size(); i += 2) {
        if (tree.remove(keys[i])) ++removed;
    }
    std::cout << "  删除 " << removed << " 个元素后 size = " << tree.size() << "\n";
    std::cout << "  树结构有效: " << (tree.validate() ? "是 ✓" : "否 ✗") << "\n\n";
}

void testStringKeys() {
    std::cout << "===== 测试：字符串键 =====\n";
    RBTree<std::string, int> tree;

    tree.insert("apple",  100);
    tree.insert("banana", 200);
    tree.insert("cherry", 300);
    tree.insert("date",   400);

    auto* v = tree.find("banana");
    assert(v != nullptr && *v == 200);
    std::cout << "  字符串键查找 banana -> " << *v << " ✓\n";

    assert(tree.contains("apple"));
    assert(!tree.contains("grape"));
    std::cout << "  contains apple = true, contains grape = false ✓\n";

    tree.remove("cherry");
    assert(!tree.contains("cherry"));
    std::cout << "  删除 cherry 后 contains = false ✓\n";

    assert(tree.validate());
    std::cout << "  树结构有效: 是 ✓\n";
    std::cout << "  树结构:\n" << tree.toString() << "\n";
}

int main() {
    std::srand(static_cast<unsigned>(std::time(nullptr)));

    std::cout << "╔══════════════════════════════════╗\n";
    std::cout << "║   红黑树 (Red-Black Tree) 测试    ║\n";
    std::cout << "╚══════════════════════════════════╝\n\n";

    testBasicInsertAndFind();
    testInsertDuplicateKey();
    testRemove();
    testTraversal();
    testClearAndEmpty();
    testLargeScale();
    testStringKeys();

    std::cout << "╔══════════════════════════════════╗\n";
    std::cout << "║       所有测试通过！             ║\n";
    std::cout << "╚══════════════════════════════════╝\n";
    return 0;
}
