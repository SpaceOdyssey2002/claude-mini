#ifndef RBTREE_HPP
#define RBTREE_HPP

#include <iostream>
#include <queue>
#include <sstream>
#include <functional>

/**
 * 红黑树（Red-Black Tree）C++ 实现
 *
 * 性质：
 * 1. 每个节点是红色或黑色
 * 2. 根节点是黑色
 * 3. 叶子节点（NIL）是黑色
 * 4. 红色节点的两个子节点都是黑色（不能有连续的红色节点）
 * 5. 从任意节点到其每个叶子节点的所有路径都包含相同数目的黑色节点
 */

template<typename K, typename V>
class RBTree {
public:
    enum Color { RED, BLACK };

    struct Node {
        K key;
        V value;
        Color color;
        Node* left;
        Node* right;
        Node* parent;

        Node(const K& k, const V& v, Color c = RED, Node* p = nullptr,
             Node* l = nullptr, Node* r = nullptr)
            : key(k), value(v), color(c), parent(p), left(l), right(r) {}
    };

private:
    Node* root_;
    Node* nil_;    // 哨兵节点（代表 NIL 叶子）
    size_t size_;

    // ---------- 辅助函数 ----------

    Node* createNode(const K& key, const V& val, Color color = RED) {
        Node* n = new Node(key, val, color, nil_, nil_, nil_);
        return n;
    }

    // 递归删除子树
    void destroySubtree(Node* x) {
        if (x == nil_) return;
        destroySubtree(x->left);
        destroySubtree(x->right);
        delete x;
    }

    // ---------- 旋转 ----------

    // 左旋：以 x 为轴，x 的右子节点上升为父节点
    void leftRotate(Node* x) {
        Node* y = x->right;
        x->right = y->left;
        if (y->left != nil_) {
            y->left->parent = x;
        }
        y->parent = x->parent;
        if (x->parent == nil_) {
            root_ = y;
        } else if (x == x->parent->left) {
            x->parent->left = y;
        } else {
            x->parent->right = y;
        }
        y->left = x;
        x->parent = y;
    }

    // 右旋：以 x 为轴，x 的左子节点上升为父节点
    void rightRotate(Node* x) {
        Node* y = x->left;
        x->left = y->right;
        if (y->right != nil_) {
            y->right->parent = x;
        }
        y->parent = x->parent;
        if (x->parent == nil_) {
            root_ = y;
        } else if (x == x->parent->right) {
            x->parent->right = y;
        } else {
            x->parent->left = y;
        }
        y->right = x;
        x->parent = y;
    }

    // ---------- 插入修复 ----------

    void insertFixup(Node* z) {
        while (z->parent->color == RED) {
            if (z->parent == z->parent->parent->left) {
                Node* y = z->parent->parent->right;  // 叔节点
                if (y->color == RED) {
                    // Case 1: 叔节点是红色 -> 变色即可
                    z->parent->color = BLACK;
                    y->color = BLACK;
                    z->parent->parent->color = RED;
                    z = z->parent->parent;
                } else {
                    if (z == z->parent->right) {
                        // Case 2: z 是右孩子 -> 左旋转为 Case 3
                        z = z->parent;
                        leftRotate(z);
                    }
                    // Case 3: z 是左孩子 -> 右旋 + 变色
                    z->parent->color = BLACK;
                    z->parent->parent->color = RED;
                    rightRotate(z->parent->parent);
                }
            } else {
                // 对称情况：父节点是右孩子
                Node* y = z->parent->parent->left;
                if (y->color == RED) {
                    z->parent->color = BLACK;
                    y->color = BLACK;
                    z->parent->parent->color = RED;
                    z = z->parent->parent;
                } else {
                    if (z == z->parent->left) {
                        z = z->parent;
                        rightRotate(z);
                    }
                    z->parent->color = BLACK;
                    z->parent->parent->color = RED;
                    leftRotate(z->parent->parent);
                }
            }
        }
        root_->color = BLACK;
    }

    // ---------- 删除修复 ----------

    void transplant(Node* u, Node* v) {
        if (u->parent == nil_) {
            root_ = v;
        } else if (u == u->parent->left) {
            u->parent->left = v;
        } else {
            u->parent->right = v;
        }
        v->parent = u->parent;
    }

    Node* subtreeMinimum(Node* x) const {
        while (x->left != nil_) {
            x = x->left;
        }
        return x;
    }

    void deleteFixup(Node* x) {
        while (x != root_ && x->color == BLACK) {
            if (x == x->parent->left) {
                Node* w = x->parent->right;  // 兄弟节点
                if (w->color == RED) {
                    // Case 1: 兄弟是红色
                    w->color = BLACK;
                    x->parent->color = RED;
                    leftRotate(x->parent);
                    w = x->parent->right;
                }
                if (w->left->color == BLACK && w->right->color == BLACK) {
                    // Case 2: 兄弟的两个孩子都是黑色
                    w->color = RED;
                    x = x->parent;
                } else {
                    if (w->right->color == BLACK) {
                        // Case 3: 兄弟的右孩子是黑色，左孩子是红色
                        w->left->color = BLACK;
                        w->color = RED;
                        rightRotate(w);
                        w = x->parent->right;
                    }
                    // Case 4: 兄弟的右孩子是红色
                    w->color = x->parent->color;
                    x->parent->color = BLACK;
                    w->right->color = BLACK;
                    leftRotate(x->parent);
                    x = root_;
                }
            } else {
                // 对称情况
                Node* w = x->parent->left;
                if (w->color == RED) {
                    w->color = BLACK;
                    x->parent->color = RED;
                    rightRotate(x->parent);
                    w = x->parent->left;
                }
                if (w->right->color == BLACK && w->left->color == BLACK) {
                    w->color = RED;
                    x = x->parent;
                } else {
                    if (w->left->color == BLACK) {
                        w->right->color = BLACK;
                        w->color = RED;
                        leftRotate(w);
                        w = x->parent->left;
                    }
                    w->color = x->parent->color;
                    x->parent->color = BLACK;
                    w->left->color = BLACK;
                    rightRotate(x->parent);
                    x = root_;
                }
            }
        }
        x->color = BLACK;
    }

    // ---------- 递归遍历辅助 ----------

    void inorderWalk(Node* x, std::function<void(const K&, const V&)> visit) const {
        if (x == nil_) return;
        inorderWalk(x->left, visit);
        visit(x->key, x->value);
        inorderWalk(x->right, visit);
    }

    void preorderWalk(Node* x, std::function<void(const K&, const V&)> visit) const {
        if (x == nil_) return;
        visit(x->key, x->value);
        preorderWalk(x->left, visit);
        preorderWalk(x->right, visit);
    }

    void postorderWalk(Node* x, std::function<void(const K&, const V&)> visit) const {
        if (x == nil_) return;
        postorderWalk(x->left, visit);
        postorderWalk(x->right, visit);
        visit(x->key, x->value);
    }

    // ---------- 验证红黑树性质 ----------

    // 检查性质 4：红色节点的子节点都是黑色
    bool checkRedProperty(Node* x) const {
        if (x == nil_) return true;
        if (x->color == RED) {
            if (x->left->color != BLACK || x->right->color != BLACK) {
                return false;
            }
        }
        return checkRedProperty(x->left) && checkRedProperty(x->right);
    }

    // 计算黑色高度并检查性质 5
    int checkBlackHeight(Node* x) const {
        if (x == nil_) return 1;
        int leftBH = checkBlackHeight(x->left);
        int rightBH = checkBlackHeight(x->right);
        if (leftBH == -1 || rightBH == -1 || leftBH != rightBH) {
            return -1;
        }
        return leftBH + (x->color == BLACK ? 1 : 0);
    }

    // 内部查找
    Node* searchNode(const K& key) const {
        Node* x = root_;
        while (x != nil_) {
            if (key < x->key) {
                x = x->left;
            } else if (x->key < key) {
                x = x->right;
            } else {
                return x;
            }
        }
        return nil_;
    }

    Node* searchNode(const K& key) {
        Node* x = root_;
        while (x != nil_) {
            if (key < x->key) {
                x = x->left;
            } else if (x->key < key) {
                x = x->right;
            } else {
                return x;
            }
        }
        return nil_;
    }

public:
    // ---------- 构造 / 析构 ----------

    RBTree() {
        nil_ = new Node(K(), V(), BLACK, nullptr, nullptr, nullptr);
        nil_->left = nil_->right = nil_->parent = nil_;
        root_ = nil_;
        size_ = 0;
    }

    ~RBTree() {
        destroySubtree(root_);
        delete nil_;
    }

    // 禁止拷贝
    RBTree(const RBTree&) = delete;
    RBTree& operator=(const RBTree&) = delete;

    // ---------- 基本操作 ----------

    size_t size() const { return size_; }
    bool empty() const { return size_ == 0; }

    // 插入 key-value
    void insert(const K& key, const V& value) {
        Node* z = createNode(key, value);
        Node* y = nil_;
        Node* x = root_;

        while (x != nil_) {
            y = x;
            if (z->key < x->key) {
                x = x->left;
            } else if (x->key < z->key) {
                x = x->right;
            } else {
                // 键已存在，更新值
                delete z;
                x->value = value;
                return;
            }
        }

        z->parent = y;
        if (y == nil_) {
            root_ = z;
        } else if (z->key < y->key) {
            y->left = z;
        } else {
            y->right = z;
        }

        z->left = nil_;
        z->right = nil_;
        z->color = RED;
        ++size_;

        insertFixup(z);
    }

    // 按 key 删除节点
    bool remove(const K& key) {
        Node* z = searchNode(key);
        if (z == nil_) return false;

        Node* y = z;
        Color yOriginalColor = y->color;
        Node* x;

        if (z->left == nil_) {
            x = z->right;
            transplant(z, z->right);
        } else if (z->right == nil_) {
            x = z->left;
            transplant(z, z->left);
        } else {
            y = subtreeMinimum(z->right);
            yOriginalColor = y->color;
            x = y->right;
            if (y->parent == z) {
                x->parent = y;
            } else {
                transplant(y, y->right);
                y->right = z->right;
                y->right->parent = y;
            }
            transplant(z, y);
            y->left = z->left;
            y->left->parent = y;
            y->color = z->color;
        }

        delete z;
        --size_;

        if (yOriginalColor == BLACK) {
            deleteFixup(x);
        }
        return true;
    }

    // 查找（返回值的指针，未找到返回 nullptr）
    V* find(const K& key) {
        Node* x = searchNode(key);
        return (x != nil_) ? &(x->value) : nullptr;
    }

    const V* find(const K& key) const {
        Node* x = searchNode(key);
        return (x != nil_) ? &(x->value) : nullptr;
    }

    // 判断 key 是否存在
    bool contains(const K& key) const {
        return searchNode(key) != nil_;
    }

    // 清空所有节点
    void clear() {
        destroySubtree(root_);
        root_ = nil_;
        size_ = 0;
    }

    // ---------- 遍历 ----------

    void inorder(std::function<void(const K&, const V&)> visit) const {
        inorderWalk(root_, visit);
    }

    void preorder(std::function<void(const K&, const V&)> visit) const {
        preorderWalk(root_, visit);
    }

    void postorder(std::function<void(const K&, const V&)> visit) const {
        postorderWalk(root_, visit);
    }

    // ---------- 验证树结构 ----------

    bool validate() const {
        if (root_->color != BLACK) {
            std::cerr << "[无效] 根节点不是黑色\n";
            return false;
        }
        if (!checkRedProperty(root_)) {
            std::cerr << "[无效] 存在连续的红色节点（违反性质 4）\n";
            return false;
        }
        int bh = checkBlackHeight(root_);
        if (bh == -1) {
            std::cerr << "[无效] 黑色高度不一致（违反性质 5）\n";
            return false;
        }
        return true;
    }

    // ---------- 层序遍历打印 ----------

    std::string toString() const {
        if (root_ == nil_) return "(空树)";

        std::ostringstream oss;
        std::queue<Node*> q;
        q.push(root_);

        while (!q.empty()) {
            size_t levelSize = q.size();
            for (size_t i = 0; i < levelSize; ++i) {
                Node* cur = q.front();
                q.pop();

                oss << cur->key
                    << (cur->color == RED ? "(R)" : "(B)")
                    << " ";

                if (cur->left != nil_)  q.push(cur->left);
                if (cur->right != nil_) q.push(cur->right);
            }
            oss << "\n";
        }
        return oss.str();
    }

    Node* getRoot() const { return root_; }
    Node* getNil() const { return nil_; }
};

#endif // RBTREE_HPP
